import csv
import gzip
import hashlib
import json
import os
import re
import sqlite3
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import pysam
import requests
from Bio.Seq import Seq
from genome_identity import (
    genome_key as provider_aware_genome_key,
    normalize_provider,
    normalize_source_database,
    selection_key as provider_aware_selection_key,
    selection_key_from_record,
    storage_path_parts,
)

STATS_SCHEMA_VERSION = "stats.v5"
STRUCTURAL_PROFILE = "canonical_coding"
ENA_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days
REGULAR_INTRON_MIN_BP = 50
SMALL_INTRON_GAP_BP = 75

MAJOR_BIOTYPE_CLASSES = ["coding", "lnoncoding", "snoncoding", "pseudogene"]

# Ensembl core biotype_group names are typically: coding, lnoncoding, mnoncoding,
# snoncoding, pseudogene. We collapse them into app-facing major classes.
_ENSEMBL_GROUP_TO_MAJOR = {
    "coding": "coding",
    "noncoding": "lnoncoding",
    "lnoncoding": "lnoncoding",
    "mnoncoding": "snoncoding",
    "snoncoding": "snoncoding",
    "pseudogene": "pseudogene",
}

# Fallback map used when local indexes do not include core biotype tables.
# Keys are lower-cased biotype names.
_FALLBACK_BIOTYPE_GROUP_BY_NAME = {
    "protein_coding": "coding",
    "protein_coding_lof": "coding",
    "protein_coding_cds_not_defined": "coding",
    "nonsense_mediated_decay": "coding",
    "non_stop_decay": "coding",
    "retained_intron": "coding",
    "lncrna": "lnoncoding",
    "lincrna": "lnoncoding",
    "lnc_rna": "lnoncoding",
    "ncrna": "lnoncoding",
    "non_coding": "lnoncoding",
    "known_ncrna": "lnoncoding",
    "processed_transcript": "lnoncoding",
    "antisense": "lnoncoding",
    "sense_intronic": "lnoncoding",
    "sense_overlapping": "lnoncoding",
    "3prime_overlapping_ncrna": "lnoncoding",
    "bidirectional_promoter_lncrna": "lnoncoding",
    "macro_lncrna": "lnoncoding",
    "tec": "lnoncoding",
    "mirna": "mnoncoding",
    "sirna": "mnoncoding",
    "pirna": "mnoncoding",
    "snorna": "snoncoding",
    "snrna": "snoncoding",
    "rrna": "snoncoding",
    "trna": "snoncoding",
    "misc_rna": "snoncoding",
    "ribozyme": "snoncoding",
    "scarna": "snoncoding",
    "srna": "snoncoding",
    "y_rna": "snoncoding",
    "vault_rna": "snoncoding",
    "rnase_mrp_rna": "snoncoding",
    "rnase_p_rna": "snoncoding",
    "mt_trna": "snoncoding",
    "mt_rrna": "snoncoding",
}

HOMOLOGY_IDENTITY_COL_CANDIDATES = [
    "query_perc_id",
    "perc_id",
    "percentage_identity",
    "identity",
    "aa_identity",
]
HOMOLOGY_COVERAGE_COL_CANDIDATES = [
    "query_perc_cov",
    "perc_cov",
    "percentage_coverage",
    "coverage",
    "aa_coverage",
]
HOMOLOGY_TYPE_COL_CANDIDATES = ["homology_type", "type"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso_to_ts(value: str) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def open_maybe_gz(path: Path):
    if str(path).lower().endswith((".gz", ".bgz")):
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "r", encoding="utf-8")


def safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if text == "":
        return None
    try:
        parsed = float(text)
    except Exception:
        return None
    if not (parsed == parsed):  # NaN guard
        return None
    return parsed


def safe_mean(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    return sum(values) / len(values)


def safe_median(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    return float(statistics.median(values))


def percentile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    pos = (len(ordered) - 1) * max(0.0, min(1.0, q))
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    if lower == upper:
        return float(ordered[lower])
    frac = pos - lower
    return float(ordered[lower] * (1.0 - frac) + ordered[upper] * frac)


def reverse_complement(seq: str) -> str:
    return str(Seq(seq).reverse_complement())


def normalize_biotype_name(raw_biotype: str) -> str:
    return str(raw_biotype or "").strip().lower()


def normalize_ensembl_group_name(raw_group: str) -> str:
    g = str(raw_group or "").strip().lower().replace("-", "_")
    if g in {"non_coding", "noncoding"}:
        return "noncoding"
    return g


def _major_class_from_group(group_name: str) -> str:
    normalized = normalize_ensembl_group_name(group_name)
    return _ENSEMBL_GROUP_TO_MAJOR.get(normalized, "lnoncoding")


def _fallback_group_for_biotype(biotype_name: str) -> str:
    b = normalize_biotype_name(biotype_name)
    if not b:
        return ""
    if b in _FALLBACK_BIOTYPE_GROUP_BY_NAME:
        return _FALLBACK_BIOTYPE_GROUP_BY_NAME[b]
    if "pseudogene" in b:
        return "pseudogene"
    if b.startswith("protein_coding"):
        return "coding"
    if b.startswith("ig_") or b.startswith("tr_"):
        if b.endswith("_pseudogene"):
            return "pseudogene"
        return "coding"
    if "rna" in b or b.endswith("_gene"):
        return "lnoncoding"
    return ""


def _table_columns(conn: sqlite3.Connection, table_name: str) -> List[str]:
    c = conn.cursor()
    c.execute(f"PRAGMA table_info({table_name})")
    return [str(r[1]) for r in c.fetchall()]


def load_core_biotype_group_lookup(conn: sqlite3.Connection) -> Dict[str, str]:
    """
    Build biotype->biotype_group lookup from Ensembl-like core schema tables if present.
    Falls back to empty mapping when indexes do not contain these tables.
    """
    if not query_table_exists(conn, "biotype"):
        return {}

    biotype_cols = set(_table_columns(conn, "biotype"))
    if not biotype_cols:
        return {}

    name_col = "name" if "name" in biotype_cols else ("biotype" if "biotype" in biotype_cols else "")
    if not name_col:
        return {}

    c = conn.cursor()
    out: Dict[str, str] = {}

    try:
        if query_table_exists(conn, "biotype_group") and "biotype_group_id" in biotype_cols:
            group_cols = set(_table_columns(conn, "biotype_group"))
            group_id_col = "biotype_group_id" if "biotype_group_id" in group_cols else ("id" if "id" in group_cols else "")
            group_name_col = "name" if "name" in group_cols else ("biotype_group" if "biotype_group" in group_cols else "")
            if group_id_col and group_name_col:
                c.execute(
                    f"""
                    SELECT b.{name_col} AS biotype_name, g.{group_name_col} AS group_name
                    FROM biotype b
                    JOIN biotype_group g ON b.biotype_group_id = g.{group_id_col}
                    """
                )
                for row in c.fetchall():
                    bname = normalize_biotype_name(row["biotype_name"])
                    gname = normalize_ensembl_group_name(row["group_name"])
                    if bname and gname:
                        out[bname] = gname
                return out

        if "biotype_group" in biotype_cols:
            c.execute(f"SELECT {name_col} AS biotype_name, biotype_group AS group_name FROM biotype")
            for row in c.fetchall():
                bname = normalize_biotype_name(row["biotype_name"])
                gname = normalize_ensembl_group_name(row["group_name"])
                if bname and gname:
                    out[bname] = gname
            return out
    except Exception:
        return out

    return out


def resolve_ensembl_biotype_group(raw_biotype: str, core_lookup: Optional[Dict[str, str]] = None) -> str:
    b = normalize_biotype_name(raw_biotype)
    if not b:
        return ""
    if core_lookup:
        mapped = normalize_ensembl_group_name(core_lookup.get(b, ""))
        if mapped:
            return mapped
    return _fallback_group_for_biotype(b)


def is_bgzipped(path: Path) -> bool:
    try:
        with open(path, "rb") as handle:
            header = handle.read(4)
        return header[:4] == b"\x1f\x8b\x08\x04"
    except Exception:
        return False


def ensure_pysam_fasta_path(fasta_path: str) -> str:
    src = Path(fasta_path).expanduser().resolve()
    work = src

    if src.suffix.lower() == ".gz" and not is_bgzipped(src):
        plain = src.with_suffix("")
        target = plain
        use_fallback = False
        try:
            src_stat = src.stat()
        except Exception:
            src_stat = None

        needs_refresh = not plain.exists()
        if not needs_refresh and src_stat is not None:
            try:
                needs_refresh = plain.stat().st_mtime_ns < src_stat.st_mtime_ns
            except Exception:
                needs_refresh = True

        if needs_refresh:
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
            except Exception:
                use_fallback = True
            if not os.access(str(target.parent), os.W_OK):
                use_fallback = True

            if use_fallback:
                digest_seed = f"{src}:{src_stat.st_size if src_stat else 0}:{src_stat.st_mtime_ns if src_stat else 0}"
                digest = hashlib.sha1(digest_seed.encode("utf-8")).hexdigest()
                cache_dir = Path("/tmp/ensembl_local_stats_fasta")
                cache_dir.mkdir(parents=True, exist_ok=True)
                target = cache_dir / f"{digest}_{plain.name}"

            temp_target = target.with_suffix(target.suffix + ".tmp")
            with gzip.open(src, "rb") as gz_in, open(temp_target, "wb") as out:
                while True:
                    chunk = gz_in.read(1024 * 1024 * 8)
                    if not chunk:
                        break
                    out.write(chunk)
            os.replace(temp_target, target)
        work = target

    fai_path = Path(f"{work}.fai")
    if not fai_path.exists():
        pysam.faidx(str(work))
    return str(work)


def classify_biotype_class(raw_biotype: str, core_lookup: Optional[Dict[str, str]] = None) -> str:
    group_name = resolve_ensembl_biotype_group(raw_biotype, core_lookup)
    major = _major_class_from_group(group_name)
    if major in MAJOR_BIOTYPE_CLASSES:
        return major
    return "lnoncoding"


def clean_species_record(raw: Dict[str, Any]) -> Dict[str, Any]:
    files = raw.get("files") or {}
    assembly = str(raw.get("assembly") or raw.get("gca") or "").strip()
    provider = normalize_provider(raw.get("provider"), is_manual=bool(raw.get("is_manual")))
    dataset_release_key = str(raw.get("dataset_release_key") or "").strip()
    assembly_key = provider_aware_genome_key(
        raw.get("species_key", ""),
        assembly,
        provider,
        bool(raw.get("is_manual")),
    )
    selected_key = str(raw.get("selection_key") or "").strip() or provider_aware_selection_key(
        raw.get("species_key", ""),
        assembly,
        provider,
        dataset_release_key,
        bool(raw.get("is_manual")),
    )
    return {
        "species_key": str(raw.get("species_key") or "").strip(),
        "assembly": assembly,
        "assembly_name": str(raw.get("assembly_name") or assembly or "").strip(),
        "scientific_name": str(raw.get("scientific_name") or "").strip(),
        "common_name": str(raw.get("common_name") or "").strip(),
        "provider": provider,
        "source_database": normalize_source_database(raw.get("source_database"), provider, assembly),
        "gca": str(raw.get("gca") or assembly or "").strip(),
        "assembly_key": str(raw.get("assembly_key") or assembly_key or "").strip(),
        "selection_key": selected_key,
        "dataset_release_key": dataset_release_key,
        "dataset_release_source": str(raw.get("dataset_release_source") or "").strip(),
        "dataset_release_date": str(raw.get("dataset_release_date") or "").strip(),
        "dataset_release_label": str(raw.get("dataset_release_label") or "").strip(),
        "dataset_release_short_label": str(raw.get("dataset_release_short_label") or "").strip(),
        "files": {
            "gff3": str(files.get("gff3") or "").strip(),
            "index": str(files.get("index") or "").strip(),
            "fasta": str(files.get("fasta") or "").strip(),
            "homology": str(files.get("homology") or "").strip(),
            "metadata": str(files.get("metadata") or "").strip(),
        },
    }


def genome_key(species: Dict[str, Any]) -> str:
    return selection_key_from_record(species) or provider_aware_genome_key(
        species.get("species_key", ""),
        species.get("assembly", ""),
        species.get("provider", ""),
        bool(species.get("is_manual")),
    )


def compute_source_fingerprints(files: Dict[str, str]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    for key in ("gff3", "index", "fasta", "homology", "metadata"):
        p = str(files.get(key) or "").strip()
        if not p:
            out[key] = {"path": "", "exists": False, "size": None, "mtime_ns": None}
            continue
        resolved = str(Path(p).expanduser().resolve())
        try:
            stat = os.stat(resolved)
            out[key] = {
                "path": resolved,
                "exists": True,
                "size": int(stat.st_size),
                "mtime_ns": int(stat.st_mtime_ns),
            }
        except Exception:
            out[key] = {"path": resolved, "exists": False, "size": None, "mtime_ns": None}
    return out


def fingerprints_equal(a: Dict[str, Any], b: Dict[str, Any], keys: Iterable[str]) -> bool:
    for key in keys:
        av = a.get(key) or {}
        bv = b.get(key) or {}
        if (
            str(av.get("path") or "") != str(bv.get("path") or "")
            or bool(av.get("exists")) != bool(bv.get("exists"))
            or av.get("size") != bv.get("size")
            or av.get("mtime_ns") != bv.get("mtime_ns")
        ):
            return False
    return True


def ensure_parent_dir(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)


def is_writable_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        test_path = path / ".write_test"
        with open(test_path, "w", encoding="utf-8") as handle:
            handle.write("ok")
        test_path.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def choose_stats_cache_path(
    species: Dict[str, Any],
    output_dir: str,
    cache_root: Path,
) -> Path:
    files = species.get("files") or {}
    gff3 = str(files.get("gff3") or "").strip()
    species_key = str(species.get("species_key") or "").strip()
    assembly = str(species.get("assembly") or "").strip()
    provider = normalize_provider(species.get("provider"), is_manual=bool(species.get("is_manual")))

    if output_dir and species_key and assembly:
        local_dir = Path(output_dir).expanduser().resolve() / "local_data"
        for part in storage_path_parts(provider, species_key, assembly):
            local_dir = local_dir / part
        dataset_release_key = str(species.get("dataset_release_key") or "").strip()
        if dataset_release_key and gff3:
            try:
                gff_resolved = Path(gff3).expanduser().resolve()
                if gff_resolved.is_file() and str(gff_resolved).startswith(str(local_dir)):
                    prefix = re.sub(r"\.gff3(\.(?:gz|bgz))?$", "", gff_resolved.name, flags=re.IGNORECASE) or "genome"
                    release_candidate = gff_resolved.parent / f"{prefix}.stats.v1.json"
                    if is_writable_dir(release_candidate.parent):
                        return release_candidate
            except Exception:
                pass
        candidate = local_dir / f"{assembly}.stats.v1.json"
        try:
            local_dir = local_dir.resolve()
            if gff3:
                gff_resolved = Path(gff3).expanduser().resolve()
                if gff_resolved.is_file() and str(gff_resolved).startswith(str(local_dir)):
                    return candidate
            if candidate.parent.exists():
                return candidate
        except Exception:
            pass

    if gff3:
        gff_path = Path(gff3).expanduser().resolve()
        prefix = re.sub(r"\.gff3(\.(?:gz|bgz))?$", "", gff_path.name, flags=re.IGNORECASE) or "genome"
        preferred = gff_path.parent / f"{prefix}.stats.v1.json"
        if is_writable_dir(preferred.parent):
            return preferred

    digest = hashlib.sha1(f"{species_key}|{assembly}|{gff3}".encode("utf-8")).hexdigest()
    manual_dir = cache_root / "stats" / "manual"
    manual_dir.mkdir(parents=True, exist_ok=True)
    return manual_dir / f"{digest}.stats.v1.json"


def load_stats_cache(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def save_stats_cache(path: Path, payload: Dict[str, Any]):
    ensure_parent_dir(path)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def ensure_stats_cache_base(existing: Dict[str, Any], species: Dict[str, Any], fingerprints: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(existing or {})
    out["schema_version"] = STATS_SCHEMA_VERSION
    out["genome"] = {
        "species_key": species.get("species_key", ""),
        "assembly": species.get("assembly", ""),
        "assembly_name": species.get("assembly_name", ""),
        "scientific_name": species.get("scientific_name", ""),
        "common_name": species.get("common_name", ""),
        "provider": species.get("provider", ""),
        "source_database": species.get("source_database", ""),
        "gca": species.get("gca", ""),
    }
    out.setdefault("computed_at", {})
    out.setdefault("sections", {})
    out["source_fingerprints"] = fingerprints
    return out


def query_table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    c = conn.cursor()
    c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (table_name,))
    return c.fetchone() is not None


def query_column_exists(conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    c = conn.cursor()
    c.execute(f"PRAGMA table_info({table_name})")
    rows = c.fetchall()
    return any(str(r[1]) == column_name for r in rows)


def compute_annotation_stats(index_path: str) -> Dict[str, Any]:
    conn = sqlite3.connect(index_path)
    conn.row_factory = sqlite3.Row
    try:
        c = conn.cursor()
        core_biotype_lookup = load_core_biotype_group_lookup(conn)
        c.execute("SELECT COUNT(*) AS n FROM genes")
        gene_total = int(c.fetchone()["n"] or 0)

        transcript_total = 0
        if query_table_exists(conn, "transcripts"):
            c.execute("SELECT COUNT(*) AS n FROM transcripts")
            transcript_total = int(c.fetchone()["n"] or 0)

        gene_biotype_counts: Dict[str, int] = {}
        c.execute("SELECT COALESCE(NULLIF(TRIM(biotype), ''), 'unknown') AS biotype, COUNT(*) AS n FROM genes GROUP BY 1")
        for row in c.fetchall():
            biotype = str(row["biotype"] or "unknown")
            gene_biotype_counts[biotype] = int(row["n"] or 0)

        transcript_biotype_counts: Dict[str, int] = {}
        single_exon_genes = 0
        genes_with_selected_tx = 0

        if query_table_exists(conn, "transcripts"):
            has_is_canonical = query_column_exists(conn, "transcripts", "is_canonical")
            order_sql = "ORDER BY parent_gene_id, is_canonical DESC, start ASC" if has_is_canonical else "ORDER BY parent_gene_id, start ASC"
            c.execute(f"SELECT parent_gene_id, data FROM transcripts {order_sql}")

            selected_tx_by_gene: Dict[str, Dict[str, Any]] = {}
            for row in c.fetchall():
                parent_gene_id = str(row["parent_gene_id"] or "")
                if not parent_gene_id:
                    continue
                if parent_gene_id in selected_tx_by_gene:
                    continue
                try:
                    data = json.loads(row["data"] or "{}")
                except Exception:
                    data = {}
                selected_tx_by_gene[parent_gene_id] = data

                tx_biotype = str(data.get("biotype") or "unknown").strip() or "unknown"
                transcript_biotype_counts[tx_biotype] = transcript_biotype_counts.get(tx_biotype, 0) + 1

            for _, tx in selected_tx_by_gene.items():
                exons = tx.get("exons") or []
                if len(exons) == 1:
                    single_exon_genes += 1
            genes_with_selected_tx = len(selected_tx_by_gene)

            # Add remaining transcript biotype counts from all transcripts for full transcript-level stats.
            c.execute("SELECT data FROM transcripts")
            transcript_biotype_counts = {}
            for row in c.fetchall():
                try:
                    data = json.loads(row["data"] or "{}")
                except Exception:
                    data = {}
                tx_biotype = str(data.get("biotype") or "unknown").strip() or "unknown"
                transcript_biotype_counts[tx_biotype] = transcript_biotype_counts.get(tx_biotype, 0) + 1

        gene_major = {k: 0 for k in MAJOR_BIOTYPE_CLASSES}
        for biotype, count in gene_biotype_counts.items():
            cls = classify_biotype_class(biotype, core_biotype_lookup)
            gene_major[cls] = gene_major.get(cls, 0) + int(count)

        transcript_major = {k: 0 for k in MAJOR_BIOTYPE_CLASSES}
        for biotype, count in transcript_biotype_counts.items():
            cls = classify_biotype_class(biotype, core_biotype_lookup)
            transcript_major[cls] = transcript_major.get(cls, 0) + int(count)

        gene_biotype_group_map = {
            biotype: resolve_ensembl_biotype_group(biotype, core_biotype_lookup)
            for biotype in gene_biotype_counts.keys()
        }
        gene_biotype_major_class_map = {
            biotype: classify_biotype_class(biotype, core_biotype_lookup)
            for biotype in gene_biotype_counts.keys()
        }
        transcript_biotype_group_map = {
            biotype: resolve_ensembl_biotype_group(biotype, core_biotype_lookup)
            for biotype in transcript_biotype_counts.keys()
        }
        transcript_biotype_major_class_map = {
            biotype: classify_biotype_class(biotype, core_biotype_lookup)
            for biotype in transcript_biotype_counts.keys()
        }

        return {
            "gene_total": gene_total,
            "transcript_total": transcript_total,
            "major_class_gene_counts": gene_major,
            "major_class_transcript_counts": transcript_major,
            "gene_biotype_counts": dict(sorted(gene_biotype_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
            "transcript_biotype_counts": dict(sorted(transcript_biotype_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
            "gene_biotype_group_map": dict(sorted(gene_biotype_group_map.items(), key=lambda kv: kv[0])),
            "gene_biotype_major_class_map": dict(sorted(gene_biotype_major_class_map.items(), key=lambda kv: kv[0])),
            "transcript_biotype_group_map": dict(sorted(transcript_biotype_group_map.items(), key=lambda kv: kv[0])),
            "transcript_biotype_major_class_map": dict(sorted(transcript_biotype_major_class_map.items(), key=lambda kv: kv[0])),
            "single_exon_genes": single_exon_genes,
            "genes_with_selected_transcript": genes_with_selected_tx,
        }
    finally:
        conn.close()


def extract_oriented_sequence(
    fasta: pysam.FastaFile,
    chrom: str,
    start: int,
    end: int,
    strand: str,
) -> str:
    seq = fasta.fetch(chrom, max(0, start - 1), end)
    if strand == "-":
        return reverse_complement(seq)
    return seq.upper()


def introns_from_exons(exons: List[Dict[str, Any]]) -> List[Tuple[int, int]]:
    if not exons or len(exons) < 2:
        return []
    ordered = sorted(exons, key=lambda e: int(e.get("start") or 0))
    introns: List[Tuple[int, int]] = []
    for i in range(len(ordered) - 1):
        left = ordered[i]
        right = ordered[i + 1]
        intron_start = int(left.get("end") or 0) + 1
        intron_end = int(right.get("start") or 0) - 1
        if intron_end < intron_start:
            continue
        introns.append((intron_start, intron_end))
    return introns


def evaluate_regular_cds(
    fasta: pysam.FastaFile,
    chrom: str,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
) -> Dict[str, Any]:
    out = {
        "is_regular": False,
        "has_start_stop": False,
        "intron_count": 0,
        "small_intron_count": 0,
        "non_canonical_splice_count": 0,
    }
    if not cds_list:
        return out

    sorted_cds = sorted(cds_list, key=lambda c: int(c.get("start") or 0))
    first_cds_start = int(sorted_cds[0].get("start") or 0)
    last_cds_end = int(sorted_cds[-1].get("end") or 0)
    if first_cds_start <= 0 or last_cds_end <= 0 or last_cds_end < first_cds_start:
        return out

    if strand == "+":
        start_start = first_cds_start
        start_end = first_cds_start + 2
        stop_start = last_cds_end - 2
        stop_end = last_cds_end
    else:
        start_start = last_cds_end - 2
        start_end = last_cds_end
        stop_start = first_cds_start
        stop_end = first_cds_start + 2

    try:
        start_codon = extract_oriented_sequence(fasta, chrom, start_start, start_end, strand)
        stop_codon = extract_oriented_sequence(fasta, chrom, stop_start, stop_end, strand)
    except Exception:
        return out

    if start_codon != "ATG":
        return out
    if stop_codon not in {"TAA", "TAG", "TGA"}:
        return out
    out["has_start_stop"] = True

    introns = introns_from_exons(exons)
    out["intron_count"] = len(introns)
    all_introns_long_enough = True
    for intron_start, intron_end in introns:
        intron_len = intron_end - intron_start + 1
        if intron_len < SMALL_INTRON_GAP_BP:
            out["small_intron_count"] += 1
        if intron_len <= REGULAR_INTRON_MIN_BP:
            all_introns_long_enough = False

        try:
            intron_seq = extract_oriented_sequence(fasta, chrom, intron_start, intron_end, strand)
        except Exception:
            out["non_canonical_splice_count"] += 1
            continue
        if len(intron_seq) < 2:
            out["non_canonical_splice_count"] += 1
            continue
        donor = intron_seq[:2].upper()
        acceptor = intron_seq[-2:].upper()
        if donor != "GT" or acceptor != "AG":
            out["non_canonical_splice_count"] += 1

    out["is_regular"] = bool(
        out["has_start_stop"]
        and out["non_canonical_splice_count"] == 0
        and all_introns_long_enough
    )
    return out


def compute_structural_stats(
    index_path: str,
    fasta_path: str,
    structural_profile: str = STRUCTURAL_PROFILE,
    include_sequence_checks: bool = True,
) -> Dict[str, Any]:
    if structural_profile != STRUCTURAL_PROFILE:
        raise ValueError(f"Unsupported structural profile: {structural_profile}")

    conn = sqlite3.connect(index_path)
    conn.row_factory = sqlite3.Row
    fasta: Optional[pysam.FastaFile] = None
    if include_sequence_checks:
        indexed_fasta_path = ensure_pysam_fasta_path(fasta_path)
        fasta = pysam.FastaFile(indexed_fasta_path)
    try:
        c = conn.cursor()
        if not query_table_exists(conn, "transcripts"):
            raise RuntimeError("Transcripts table is missing from index.")

        c.execute("SELECT id, biotype FROM genes WHERE LOWER(COALESCE(biotype, '')) = 'protein_coding'")
        coding_gene_ids = [str(r["id"]) for r in c.fetchall()]
        if not coding_gene_ids:
            return {
                "profile": structural_profile,
                "transcript_count": 0,
                "gene_count": 0,
                "regular_cds_count": 0 if include_sequence_checks else None,
                "regular_cds_fraction": None,
                "valid_cds_count": 0 if include_sequence_checks else None,
                "valid_cds_fraction": None,
                "small_intron_gap_count": 0,
                "small_intron_gap_fraction": None,
                "non_canonical_splice_count": 0 if include_sequence_checks else None,
                "non_canonical_splice_fraction": None,
                "intron_count": 0,
                "sequence_metrics_status": "ready" if include_sequence_checks else "computing",
                "pending_metrics": [] if include_sequence_checks else [
                    "regular_cds_count",
                    "regular_cds_fraction",
                    "non_canonical_splice_count",
                    "non_canonical_splice_fraction",
                ],
                "metrics": {},
            }

        placeholders = ",".join("?" for _ in coding_gene_ids)
        has_is_canonical = query_column_exists(conn, "transcripts", "is_canonical")
        if has_is_canonical:
            c.execute(
                f"""
                SELECT id, chrom, strand, parent_gene_id, is_canonical, data
                FROM transcripts
                WHERE parent_gene_id IN ({placeholders})
                ORDER BY parent_gene_id, is_canonical DESC, start ASC
                """,
                coding_gene_ids,
            )
        else:
            c.execute(
                f"""
                SELECT id, chrom, strand, parent_gene_id, data
                FROM transcripts
                WHERE parent_gene_id IN ({placeholders})
                ORDER BY parent_gene_id, start ASC
                """,
                coding_gene_ids,
            )
        by_gene: Dict[str, sqlite3.Row] = {}
        for row in c.fetchall():
            parent = str(row["parent_gene_id"] or "")
            if not parent or parent in by_gene:
                continue
            if has_is_canonical and int(row["is_canonical"] or 0) != 1:
                # Structural profile is canonical-coding only.
                continue
            by_gene[parent] = row

        exon_counts: List[int] = []
        exon_lengths: List[int] = []
        intron_lengths: List[int] = []
        cds_lengths: List[int] = []
        cds_exon_counts: List[int] = []
        utr5_lengths: List[int] = []
        utr3_lengths: List[int] = []
        small_intron_gap_count = 0

        tx_count = 0
        regular_cds_count: Optional[int] = 0 if include_sequence_checks else None
        non_canonical_splice_count: Optional[int] = 0 if include_sequence_checks else None
        for row in by_gene.values():
            tx_count += 1
            chrom = str(row["chrom"] or "")
            strand = str(row["strand"] or "+")
            try:
                data = json.loads(row["data"] or "{}")
            except Exception:
                data = {}

            exons = data.get("exons") or []
            cds_list = data.get("cds_list") or []
            utrs = data.get("utrs") or []

            exon_counts.append(len(exons))
            for exon in exons:
                exon_len = int(exon.get("end") or 0) - int(exon.get("start") or 0) + 1
                if exon_len > 0:
                    exon_lengths.append(exon_len)

            ordered_introns = introns_from_exons(exons)
            for intron_start, intron_end in ordered_introns:
                intron_len = intron_end - intron_start + 1
                if intron_len > 0:
                    intron_lengths.append(intron_len)
                    if intron_len < SMALL_INTRON_GAP_BP:
                        small_intron_gap_count += 1

            cds_exon_counts.append(len(cds_list))
            cds_total = 0
            for cds in cds_list:
                cds_len = int(cds.get("end") or 0) - int(cds.get("start") or 0) + 1
                if cds_len > 0:
                    cds_total += cds_len
            cds_lengths.append(cds_total)

            utr5_total = 0
            utr3_total = 0
            for utr in utrs:
                ft = str(utr.get("feature_type") or "")
                length = int(utr.get("end") or 0) - int(utr.get("start") or 0) + 1
                if length <= 0:
                    continue
                if ft == "five_prime_UTR":
                    utr5_total += length
                elif ft == "three_prime_UTR":
                    utr3_total += length
            utr5_lengths.append(utr5_total)
            utr3_lengths.append(utr3_total)

            if include_sequence_checks and fasta and chrom:
                regular_eval = evaluate_regular_cds(fasta, chrom, strand, exons, cds_list)
                if regular_eval.get("is_regular"):
                    regular_cds_count = int(regular_cds_count or 0) + 1
                non_canonical_splice_count = int(non_canonical_splice_count or 0) + int(regular_eval.get("non_canonical_splice_count") or 0)

        metric_values = {
            "avg_exon_count": safe_mean(exon_counts),
            "median_exon_count": safe_median(exon_counts),
            "avg_exon_size": safe_mean(exon_lengths),
            "median_exon_size": safe_median(exon_lengths),
            "avg_intron_size": safe_mean(intron_lengths),
            "median_intron_size": safe_median(intron_lengths),
            "avg_cds_length": safe_mean(cds_lengths),
            "median_cds_length": safe_median(cds_lengths),
            "avg_cds_exon_count": safe_mean(cds_exon_counts),
            "median_cds_exon_count": safe_median(cds_exon_counts),
            "avg_utr5_length": safe_mean(utr5_lengths),
            "median_utr5_length": safe_median(utr5_lengths),
            "avg_utr3_length": safe_mean(utr3_lengths),
            "median_utr3_length": safe_median(utr3_lengths),
        }
        intron_total_count = len(intron_lengths)
        regular_cds_fraction = (float(regular_cds_count) / tx_count) if (include_sequence_checks and tx_count) else None
        non_canonical_splice_fraction = (
            (float(non_canonical_splice_count) / intron_total_count)
            if (include_sequence_checks and intron_total_count)
            else None
        )
        small_intron_gap_fraction = (float(small_intron_gap_count) / intron_total_count) if intron_total_count else None

        out = {
            "profile": structural_profile,
            "gene_count": len(by_gene),
            "transcript_count": tx_count,
            "regular_cds_count": regular_cds_count,
            "regular_cds_fraction": regular_cds_fraction,
            # Compatibility aliases for older frontend reads.
            "valid_cds_count": regular_cds_count,
            "valid_cds_fraction": regular_cds_fraction,
            "small_intron_gap_count": small_intron_gap_count,
            "small_intron_gap_fraction": small_intron_gap_fraction,
            "non_canonical_splice_count": non_canonical_splice_count,
            "non_canonical_splice_fraction": non_canonical_splice_fraction,
            "intron_count": intron_total_count,
            "sequence_metrics_status": "ready" if include_sequence_checks else "computing",
            "pending_metrics": [] if include_sequence_checks else [
                "regular_cds_count",
                "regular_cds_fraction",
                "non_canonical_splice_count",
                "non_canonical_splice_fraction",
            ],
            "metrics": metric_values,
        }
        return out
    finally:
        if fasta:
            fasta.close()
        conn.close()


def detect_homology_column(columns: Sequence[str], candidates: Sequence[str]) -> Optional[str]:
    lower = {c.lower(): c for c in columns}
    for candidate in candidates:
        if candidate.lower() in lower:
            return lower[candidate.lower()]
    return None


def compute_homology_stats(homology_path: str) -> Dict[str, Any]:
    path = Path(homology_path).expanduser().resolve()
    identity_values: List[float] = []
    coverage_values: List[float] = []
    type_counts: Dict[str, int] = {}
    row_count = 0

    with open_maybe_gz(path) as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        columns = reader.fieldnames or []
        identity_col = detect_homology_column(columns, HOMOLOGY_IDENTITY_COL_CANDIDATES)
        coverage_col = detect_homology_column(columns, HOMOLOGY_COVERAGE_COL_CANDIDATES)
        type_col = detect_homology_column(columns, HOMOLOGY_TYPE_COL_CANDIDATES)

        for row in reader:
            row_count += 1
            if identity_col:
                ident = safe_float(row.get(identity_col))
                if ident is not None:
                    identity_values.append(max(0.0, min(100.0, ident)))
            if coverage_col:
                cov = safe_float(row.get(coverage_col))
                if cov is not None:
                    coverage_values.append(max(0.0, min(100.0, cov)))
            if type_col:
                t = str(row.get(type_col) or "").strip() or "unknown"
                type_counts[t] = type_counts.get(t, 0) + 1

    return {
        "row_count": row_count,
        "columns": {
            "identity": identity_col,
            "coverage": coverage_col,
            "type": type_col,
        },
        "identity": {
            "mean": safe_mean(identity_values),
            "median": safe_median(identity_values),
            "p10": percentile(identity_values, 0.10),
            "p90": percentile(identity_values, 0.90),
        },
        "coverage": {
            "mean": safe_mean(coverage_values),
            "median": safe_median(coverage_values),
            "p10": percentile(coverage_values, 0.10),
            "p90": percentile(coverage_values, 0.90),
        },
        "homology_type_counts": dict(sorted(type_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
    }


def compute_fasta_assembly_stats(fasta_path: str) -> Dict[str, Any]:
    path = Path(fasta_path).expanduser().resolve()
    lengths: List[int] = []
    current_len: Optional[int] = None
    with open_maybe_gz(path) as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith(">"):
                if current_len is not None and current_len > 0:
                    lengths.append(current_len)
                current_len = 0
                continue
            if current_len is None:
                # Ignore leading non-header lines in malformed inputs.
                continue
            current_len += len(line)
    if current_len is not None and current_len > 0:
        lengths.append(current_len)

    lengths.sort(reverse=True)
    contig_count = len(lengths)
    total_bases = sum(lengths)
    longest = lengths[0] if lengths else 0

    n50 = None
    l50 = None
    if lengths and total_bases > 0:
        threshold = total_bases / 2.0
        running = 0
        for idx, value in enumerate(lengths):
            running += value
            if running >= threshold:
                n50 = value
                l50 = idx + 1
                break

    return {
        "contig_count": contig_count,
        "total_bases": total_bases,
        "longest_sequence": longest,
        "n50": n50,
        "l50": l50,
    }


def load_ena_cache(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def save_ena_cache(path: Path, payload: Dict[str, Any]):
    ensure_parent_dir(path)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def normalize_ena_record(raw: Dict[str, Any], gca: str) -> Dict[str, Any]:
    return {
        "accession": raw.get("accession") or raw.get("assembly_accession") or gca,
        "assembly_name": raw.get("assembly_name") or raw.get("description") or "",
        "tax_id": raw.get("tax_id") or raw.get("taxid") or "",
        "scientific_name": raw.get("scientific_name") or "",
        "common_name": raw.get("common_name") or "",
        "assembly_level": raw.get("assembly_level") or "",
        "sequence_length": raw.get("sequence_length") or raw.get("total_length") or "",
        "contig_count": raw.get("contig_count") or "",
        "chromosome_count": raw.get("chromosome_count") or "",
        "submitter": raw.get("submitter") or "",
        "first_public": raw.get("first_public") or raw.get("last_updated") or "",
    }


def split_gca_accession(gca: str) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    accession = str(gca or "").strip()
    match = re.match(r"^(GCA_\d+)(?:\.(\d+))?$", accession)
    if not match:
        return None, None, None
    stem = match.group(1)
    version = match.group(2) or None
    full = f"{stem}.{version}" if version else stem
    return stem, version, full


def build_ncbi_all_prefix(stem: str) -> Optional[str]:
    digits = "".join(ch for ch in str(stem or "") if ch.isdigit())
    if not digits:
        return None
    if len(digits) % 3:
        digits = ("0" * (3 - (len(digits) % 3))) + digits
    chunks = [digits[i:i + 3] for i in range(0, len(digits), 3)]
    if not chunks:
        return None
    return f"https://ftp.ncbi.nlm.nih.gov/genomes/all/GCA/{'/'.join(chunks)}/"


def normalize_ncbi_stats_key(raw_key: str) -> str:
    text = str(raw_key or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def normalize_ncbi_assembly_record(meta: Dict[str, str], accession: str) -> Dict[str, Any]:
    return {
        "accession": meta.get("assembly_accession") or meta.get("genbank_assembly_accession") or accession,
        "assembly_name": meta.get("assembly_name") or "",
        "tax_id": meta.get("taxid") or meta.get("tax_id") or "",
        "scientific_name": meta.get("organism_name") or "",
        "common_name": "",
        "assembly_level": meta.get("assembly_level") or "",
        "sequence_length": meta.get("total_sequence_length") or meta.get("genome_size") or "",
        "contig_count": meta.get("number_of_contigs") or meta.get("contig_count") or "",
        "chromosome_count": meta.get("number_of_chromosomes") or meta.get("chromosome_count") or "",
        "submitter": meta.get("submitter") or "",
        "first_public": meta.get("date") or meta.get("seq_rel_date") or "",
        "bioproject": meta.get("bioproject") or "",
        "biosample": meta.get("biosample") or "",
    }


def fetch_ncbi_assembly_metadata(gca: str, timeout: float = 3.0) -> Optional[Dict[str, Any]]:
    stem, version, full_accession = split_gca_accession(gca)
    if not stem:
        return None
    listing_url = build_ncbi_all_prefix(stem)
    if not listing_url:
        return None

    try:
        listing_resp = requests.get(listing_url, timeout=timeout)
        if not listing_resp.ok:
            return None
        hrefs = re.findall(r'href="([^"]+)"', listing_resp.text or "")
        directories = []
        for href in hrefs:
            value = str(href or "").strip()
            if not value.endswith("/"):
                continue
            name = value.strip("/")
            if name.startswith("GCA_"):
                directories.append(name)
        if not directories:
            return None

        selected_dir = None
        if full_accession:
            prefix = f"{full_accession}_"
            for name in directories:
                if name.startswith(prefix):
                    selected_dir = name
                    break
        if selected_dir is None and version:
            generic_prefix = f"{stem}."
            for name in directories:
                if name.startswith(generic_prefix):
                    selected_dir = name
                    break
        if selected_dir is None:
            selected_dir = sorted(directories)[-1]

        stats_url = f"{listing_url}{selected_dir}/{selected_dir}_assembly_stats.txt"
        stats_resp = requests.get(stats_url, timeout=timeout)
        if not stats_resp.ok:
            return None

        meta: Dict[str, str] = {}
        for raw_line in (stats_resp.text or "").splitlines():
            line = raw_line.strip()
            if not line.startswith("#"):
                continue
            payload = line[1:].strip()
            if not payload or ":" not in payload:
                continue
            key, value = payload.split(":", 1)
            norm_key = normalize_ncbi_stats_key(key)
            if norm_key and value.strip():
                meta[norm_key] = value.strip()

        if not meta:
            return None
        normalized = normalize_ncbi_assembly_record(meta, full_accession or stem)
        return {"status": "ready", "message": "", "data": normalized, "source": "ncbi"}
    except Exception:
        return None


def fetch_ena_metadata(gca: str, ena_cache_path: Path, timeout: float = 3.0) -> Dict[str, Any]:
    accession = str(gca or "").strip()
    if not accession:
        return {"status": "missing", "message": "No assembly accession provided.", "data": None, "source": "none"}

    cache = load_ena_cache(ena_cache_path)
    cached_entry = cache.get(accession) if isinstance(cache, dict) else None
    cached_data = cached_entry.get("data") if isinstance(cached_entry, dict) else None
    cached_source = cached_entry.get("source") if isinstance(cached_entry, dict) else None
    fetched_at = cached_entry.get("fetched_at") if isinstance(cached_entry, dict) else ""
    fetched_ts = parse_iso_to_ts(fetched_at) if fetched_at else None
    now_ts = datetime.now(timezone.utc).timestamp()
    cache_fresh = bool(fetched_ts and (now_ts - fetched_ts) <= ENA_CACHE_TTL_SECONDS)

    if cache_fresh and cached_data:
        source = str(cached_source or "cache")
        return {"status": "ready", "message": "", "data": cached_data, "source": source}

    # Assembly metadata is effectively static. If we already have a cached record,
    # return it immediately instead of blocking the stats view on network refreshes.
    if cached_data:
        stale_source = str(cached_source or "cache_stale")
        return {
            "status": "ready",
            "message": "Showing cached assembly metadata.",
            "data": cached_data,
            "source": stale_source,
        }

    # First attempt: ENA Browser API
    try:
        url = f"https://www.ebi.ac.uk/ena/browser/api/json/{accession}"
        resp = requests.get(url, timeout=timeout)
        if resp.ok:
            body = resp.json()
            if isinstance(body, list) and body:
                normalized = normalize_ena_record(body[0], accession)
                cache[accession] = {"fetched_at": now_iso(), "data": normalized, "source": "ena"}
                save_ena_cache(ena_cache_path, cache)
                return {"status": "ready", "message": "", "data": normalized, "source": "ena"}
            if isinstance(body, dict) and body:
                normalized = normalize_ena_record(body, accession)
                cache[accession] = {"fetched_at": now_iso(), "data": normalized, "source": "ena"}
                save_ena_cache(ena_cache_path, cache)
                return {"status": "ready", "message": "", "data": normalized, "source": "ena"}
    except Exception:
        pass

    # Second attempt: ENA Portal search
    try:
        portal_url = "https://www.ebi.ac.uk/ena/portal/api/search"
        params = {
            "result": "assembly",
            "query": f'assembly_accession="{accession}"',
            "fields": "assembly_accession,assembly_name,tax_id,scientific_name,common_name,assembly_level,sequence_length,contig_count,chromosome_count,submitter,last_updated",
            "format": "json",
            "limit": "1",
        }
        resp = requests.get(portal_url, params=params, timeout=timeout)
        if resp.ok:
            body = resp.json()
            if isinstance(body, list) and body:
                normalized = normalize_ena_record(body[0], accession)
                cache[accession] = {"fetched_at": now_iso(), "data": normalized, "source": "ena"}
                save_ena_cache(ena_cache_path, cache)
                return {"status": "ready", "message": "", "data": normalized, "source": "ena"}
    except Exception:
        pass

    # Third attempt: NCBI assembly stats report on genomes/all FTP hierarchy.
    ncbi = fetch_ncbi_assembly_metadata(accession, timeout=timeout)
    if ncbi and ncbi.get("status") == "ready":
        cache[accession] = {"fetched_at": now_iso(), "data": ncbi.get("data"), "source": "ncbi"}
        save_ena_cache(ena_cache_path, cache)
        return ncbi

    return {
        "status": "error",
        "message": f"Unable to fetch ENA/NCBI metadata for {accession}.",
        "data": None,
        "source": "none",
    }


def build_annotation_aggregate(records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    gene_major_by_genome = []
    transcript_major_by_genome = []
    for record in records:
        if (record.get("statuses") or {}).get("annotation") != "ready":
            continue
        ann = record.get("annotation") or {}
        gene_major_by_genome.append(
            {
                "genome_key": record.get("genome_key"),
                "label": record.get("assembly_name") or record.get("assembly") or record.get("species_key"),
                "values": ann.get("major_class_gene_counts") or {},
            }
        )
        transcript_major_by_genome.append(
            {
                "genome_key": record.get("genome_key"),
                "label": record.get("assembly_name") or record.get("assembly") or record.get("species_key"),
                "values": ann.get("major_class_transcript_counts") or {},
            }
        )
    return {
        "gene_major_by_genome": gene_major_by_genome,
        "transcript_major_by_genome": transcript_major_by_genome,
    }


def build_homology_aggregate(records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    points = []
    for record in records:
        if (record.get("statuses") or {}).get("homology") != "ready":
            continue
        hom = record.get("homology") or {}
        coverage = (hom.get("coverage") or {}).get("mean")
        identity = (hom.get("identity") or {}).get("mean")
        points.append(
            {
                "genome_key": record.get("genome_key"),
                "label": record.get("assembly_name") or record.get("assembly") or record.get("species_key"),
                "mean_coverage": coverage,
                "mean_identity": identity,
                "row_count": hom.get("row_count") or 0,
            }
        )
    return {"points": points}


def build_structural_aggregate(records: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    metrics = []
    for record in records:
        status = (record.get("statuses") or {}).get("structural")
        if status != "ready":
            continue
        structural = record.get("structural") or {}
        metrics.append(
            {
                "genome_key": record.get("genome_key"),
                "label": record.get("assembly_name") or record.get("assembly") or record.get("species_key"),
                "metrics": structural.get("metrics") or {},
                "regular_cds_fraction": structural.get("regular_cds_fraction"),
                "valid_cds_fraction": structural.get("valid_cds_fraction"),
                "small_intron_gap_count": structural.get("small_intron_gap_count"),
                "small_intron_gap_fraction": structural.get("small_intron_gap_fraction"),
                "non_canonical_splice_count": structural.get("non_canonical_splice_count"),
                "non_canonical_splice_fraction": structural.get("non_canonical_splice_fraction"),
                "transcript_count": structural.get("transcript_count"),
            }
        )
    return {"by_genome": metrics}
