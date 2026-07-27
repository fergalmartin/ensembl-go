#!/usr/bin/env python3
"""Generate a manifest for Ensembl Compara pairwise alignment downloads."""

import argparse
import csv
import hashlib
import json
import re
import shutil
import subprocess
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import urljoin

import requests


BACKEND_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RELEASE = 116
DEFAULT_FTP_URL = (
    "https://ftp.ensembl.org/pub/release-116/maf/ensembl-compara/pairwise_alignments/"
)
DEFAULT_CATALOG_PATH = BACKEND_ROOT / "cache" / "remote_species_catalog.json"
DEFAULT_CATALOG_URL = "https://ftp.ebi.ac.uk/pub/ensemblorganisms/species.new_ftp_structure.json"
NCBI_DATASET_REPORT_URL = "https://api.ncbi.nlm.nih.gov/datasets/v2/genome/dataset_report"
ROW_SIDE_FIELDS = [
    "species_name",
    "compara_name",
    "display_name",
    "common_name",
    "taxon_id",
    "genome_db_id",
    "assembly_name",
    "catalog_assembly_name",
    "gca",
    "gcf",
    "primary_accession",
    "equivalent_accessions",
    "species_key",
    "catalog_match",
]
ROW_FIELDNAMES = [
    "release",
    "alignment_id",
    "method_link_species_set_id",
    "alignment_type",
    "mlss_name",
    "ftp_filename",
    "ftp_url",
    "match_status",
    "warnings",
    *[f"species_1_{field}" for field in ROW_SIDE_FIELDS],
    *[f"species_2_{field}" for field in ROW_SIDE_FIELDS],
]


COMPARA_PAIRWISE_QUERY = """
SELECT
  mlss.method_link_species_set_id,
  ml.type AS alignment_type,
  mlss.name AS mlss_name,
  gdb.genome_db_id,
  gdb.name,
  gdb.assembly,
  gdb.taxon_id,
  gdb.genome_component,
  gdb.strain_name,
  gdb.display_name,
  gdb.first_release,
  gdb.last_release
FROM method_link_species_set mlss
JOIN method_link ml USING (method_link_id)
JOIN species_set ss USING (species_set_id)
JOIN genome_db gdb USING (genome_db_id)
JOIN (
  SELECT mlss_inner.method_link_species_set_id
  FROM method_link_species_set mlss_inner
  JOIN method_link ml_inner USING (method_link_id)
  JOIN species_set ss_inner USING (species_set_id)
  WHERE ml_inner.type IN ('LASTZ_NET', 'LASTZ_PATCH', 'CACTUS_HAL_PW')
    AND (mlss_inner.last_release IS NULL OR mlss_inner.last_release >= {release})
  GROUP BY mlss_inner.method_link_species_set_id
  HAVING COUNT(*) = 2
) pairwise USING (method_link_species_set_id)
WHERE ml.type IN ('LASTZ_NET', 'LASTZ_PATCH', 'CACTUS_HAL_PW')
  AND (mlss.last_release IS NULL OR mlss.last_release >= {release})
ORDER BY ml.type, mlss.method_link_species_set_id, gdb.name
""".strip()


@dataclass(frozen=True)
class FileEndpoint:
    raw: str
    species_abbrev: str
    assembly_token: str


@dataclass(frozen=True)
class FtpAlignmentFile:
    filename: str
    url: str
    method: str
    endpoints: Tuple[FileEndpoint, FileEndpoint]


@dataclass(frozen=True)
class GenomeRow:
    method_link_species_set_id: str
    alignment_type: str
    mlss_name: str
    genome_db_id: str
    name: str
    assembly: str
    taxon_id: str = ""
    genome_component: str = ""
    strain_name: str = ""
    display_name: str = ""
    first_release: str = ""
    last_release: str = ""


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_assembly(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def assembly_lookup_keys(value: Any) -> List[str]:
    normalized = normalize_assembly(value)
    if not normalized:
        return []
    keys = [normalized]
    patchless = re.sub(r"p\d+$", "", normalized)
    if patchless and patchless != normalized:
        keys.append(patchless)
    return keys


def normalize_species_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def method_from_filename(value: str) -> str:
    return str(value or "").strip().upper()


def parse_endpoint(token: str) -> FileEndpoint:
    raw = str(token or "").strip()
    species_abbrev, sep, assembly = raw.partition("_")
    if not sep or not species_abbrev or not assembly:
        raise ValueError(f"Cannot decode alignment endpoint token: {token!r}")
    return FileEndpoint(raw=raw, species_abbrev=species_abbrev, assembly_token=assembly)


def parse_alignment_filename(filename: str, base_url: str = "") -> Optional[FtpAlignmentFile]:
    name = str(filename or "").strip().split("/")[-1]
    if not name.endswith(".tar.gz"):
        return None
    stem = name[:-7]
    pair_part, sep, method = stem.rpartition(".")
    if not sep or ".v." not in pair_part:
        return None
    left, right = pair_part.split(".v.", 1)
    try:
        endpoints = (parse_endpoint(left), parse_endpoint(right))
    except ValueError:
        return None
    return FtpAlignmentFile(
        filename=name,
        url=urljoin(base_url, name) if base_url else name,
        method=method_from_filename(method),
        endpoints=endpoints,
    )


def parse_ftp_listing(listing_html: str, base_url: str) -> List[FtpAlignmentFile]:
    hrefs = re.findall(r'href=["\']([^"\']+\.tar\.gz)["\']', listing_html or "", flags=re.I)
    seen = set()
    files: List[FtpAlignmentFile] = []
    for href in hrefs:
        filename = href.split("/")[-1]
        if filename in seen:
            continue
        parsed = parse_alignment_filename(filename, base_url)
        if parsed:
            seen.add(filename)
            files.append(parsed)
    return sorted(files, key=lambda item: item.filename)


def fetch_ftp_listing(ftp_url: str, timeout: float = 30.0) -> str:
    response = requests.get(ftp_url, timeout=timeout)
    response.raise_for_status()
    return response.text or ""


def load_catalog(catalog_path: Optional[Path], catalog_url: str) -> Dict[str, Any]:
    if catalog_path and catalog_path.exists():
        with catalog_path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        response = requests.get(catalog_url, timeout=30)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict) or not isinstance(payload.get("species"), dict):
        raise ValueError("Species catalog must be a JSON object with a 'species' object")
    return payload


def build_catalog_index(catalog: Dict[str, Any]) -> Dict[str, Any]:
    by_species_assembly: Dict[Tuple[str, str], List[Dict[str, str]]] = defaultdict(list)
    by_assembly: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    species = catalog.get("species") or {}
    for species_key, species_info in species.items():
        if not isinstance(species_info, dict):
            continue
        scientific_name = str(species_info.get("scientific_name") or species_key).strip()
        common_name = str(species_info.get("common_name") or "").strip()
        taxid = str(species_info.get("taxid") or species_info.get("species_taxonomy_id") or "").strip()
        for accession, assembly_info in (species_info.get("assemblies") or {}).items():
            if not isinstance(assembly_info, dict):
                continue
            assembly_name = str(assembly_info.get("name") or "").strip()
            entry = {
                "species_key": str(species_key),
                "scientific_name": scientific_name,
                "common_name": common_name,
                "taxon_id": taxid,
                "accession": str(accession),
                "assembly_name": assembly_name,
                "assembly_level": str(assembly_info.get("level") or "").strip(),
            }
            assembly_keys = assembly_lookup_keys(assembly_name or accession)
            if not assembly_keys:
                continue
            for assembly_key in assembly_keys:
                if entry not in by_assembly[assembly_key]:
                    by_assembly[assembly_key].append(entry)
            for species_token in {
                normalize_species_name(species_key),
                normalize_species_name(scientific_name),
            }:
                if species_token:
                    for assembly_key in assembly_keys:
                        lookup_key = (species_token, assembly_key)
                        if entry not in by_species_assembly[lookup_key]:
                            by_species_assembly[lookup_key].append(entry)
    return {"by_species_assembly": by_species_assembly, "by_assembly": by_assembly}


def _first_value(row: Dict[str, str], *names: str) -> str:
    lower_lookup = {str(k).lower(): v for k, v in row.items()}
    for name in names:
        if name in row:
            return str(row.get(name) or "").strip()
        value = lower_lookup.get(name.lower())
        if value is not None:
            return str(value or "").strip()
    return ""


def read_compara_tsv(path: Path) -> List[GenomeRow]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        rows = [
            GenomeRow(
                method_link_species_set_id=_first_value(row, "method_link_species_set_id"),
                alignment_type=_first_value(row, "alignment_type", "type"),
                mlss_name=_first_value(row, "mlss_name"),
                genome_db_id=_first_value(row, "genome_db_id"),
                name=_first_value(row, "name", "genome_name"),
                assembly=_first_value(row, "assembly"),
                taxon_id=_first_value(row, "taxon_id"),
                genome_component=_first_value(row, "genome_component"),
                strain_name=_first_value(row, "strain_name"),
                display_name=_first_value(row, "display_name"),
                first_release=_first_value(row, "first_release"),
                last_release=_first_value(row, "last_release"),
            )
            for row in reader
        ]
    return [row for row in rows if row.method_link_species_set_id and row.alignment_type and row.assembly]


def run_mysql_query(
    query: str,
    host: str,
    port: int,
    user: str,
    database: str,
    mysql_program: str = "mysql",
    extra_args: Optional[Sequence[str]] = None,
) -> str:
    program = shutil.which(mysql_program) or mysql_program
    command = [
        program,
        "--batch",
        "--raw",
        "--host",
        host,
        "--port",
        str(port),
        "--user",
        user,
        "--database",
        database,
        "--execute",
        query,
    ]
    if extra_args:
        command[1:1] = list(extra_args)
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        stderr = str(exc.stderr or "").strip()
        stdout = str(exc.stdout or "").strip()
        detail = stderr or stdout or f"exit status {exc.returncode}"
        raise RuntimeError(f"mysql query failed: {detail}") from exc
    return completed.stdout


def group_compara_rows(rows: Iterable[GenomeRow]) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[GenomeRow]] = defaultdict(list)
    for row in rows:
        grouped[row.method_link_species_set_id].append(row)
    alignments = []
    for mlss_id, genomes in grouped.items():
        if len(genomes) != 2:
            continue
        first = genomes[0]
        alignments.append(
            {
                "method_link_species_set_id": mlss_id,
                "alignment_type": first.alignment_type,
                "mlss_name": first.mlss_name,
                "genomes": sorted(genomes, key=lambda item: (item.name, item.assembly)),
            }
        )
    return sorted(alignments, key=lambda item: (item["alignment_type"], item["method_link_species_set_id"]))


def build_compara_file_index(compara_alignments: Sequence[Dict[str, Any]]) -> Dict[Tuple[str, Tuple[str, str]], List[Dict[str, Any]]]:
    index: Dict[Tuple[str, Tuple[str, str]], List[Dict[str, Any]]] = defaultdict(list)
    for alignment in compara_alignments:
        genomes = alignment.get("genomes") or []
        if len(genomes) != 2:
            continue
        assembly_key = tuple(sorted(normalize_assembly(genome.assembly) for genome in genomes))
        index[(method_from_filename(alignment.get("alignment_type", "")), assembly_key)].append(alignment)
    return index


def resolve_catalog_entries(genome: GenomeRow, catalog_index: Dict[str, Any]) -> Tuple[List[Dict[str, str]], str]:
    species_key = normalize_species_name(genome.name)
    for assembly_key in assembly_lookup_keys(genome.assembly):
        exact = catalog_index["by_species_assembly"].get((species_key, assembly_key), [])
        if exact:
            return exact, "species_and_assembly"
    for assembly_key in assembly_lookup_keys(genome.assembly):
        assembly_matches = catalog_index["by_assembly"].get(assembly_key, [])
        if len(assembly_matches) == 1:
            return assembly_matches, "unique_assembly"
        if assembly_matches:
            return assembly_matches, "ambiguous_assembly"
    return [], "none"


def fetch_ncbi_paired_accessions(accessions: Sequence[str], batch_size: int = 100) -> Dict[str, str]:
    clean = sorted({str(value).strip() for value in accessions if re.match(r"^GC[AF]_\d+\.\d+$", str(value).strip())})
    paired: Dict[str, str] = {}
    for index in range(0, len(clean), batch_size):
        batch = clean[index:index + batch_size]
        response = requests.post(
            NCBI_DATASET_REPORT_URL,
            json={"accessions": batch, "returned_content": "COMPLETE"},
            timeout=30,
        )
        response.raise_for_status()
        payload = response.json()
        for report in payload.get("reports") or []:
            accession = str(report.get("accession") or "").strip()
            pair = str(report.get("paired_accession") or "").strip()
            if accession and pair:
                paired[accession] = pair
                paired[pair] = accession
    return paired


def _ncbi_report_record(report: Dict[str, Any]) -> Dict[str, str]:
    assembly_info = report.get("assembly_info") or {}
    organism = report.get("organism") or {}
    return {
        "accession": str(report.get("accession") or report.get("current_accession") or "").strip(),
        "paired_accession": str(report.get("paired_accession") or "").strip(),
        "assembly_name": str(assembly_info.get("assembly_name") or "").strip(),
        "assembly_level": str(assembly_info.get("assembly_level") or "").strip(),
        "assembly_status": str(assembly_info.get("assembly_status") or "").strip(),
        "scientific_name": str(organism.get("organism_name") or "").strip(),
        "common_name": str(organism.get("common_name") or "").strip(),
        "taxon_id": str(organism.get("tax_id") or "").strip(),
        "source_database": str(report.get("source_database") or "").replace("SOURCE_DATABASE_", "").strip(),
    }


def _assembly_query_score(query_name: str, record: Dict[str, str]) -> int:
    query_key = normalize_assembly(query_name)
    assembly_key = normalize_assembly(record.get("assembly_name"))
    if not query_key or not assembly_key:
        return 0
    if query_key == assembly_key:
        return 100
    if assembly_key.startswith(query_key) or query_key.startswith(assembly_key):
        return 75
    query_base = re.sub(r"\d+$", "", query_key)
    assembly_base = re.sub(r"\d+$", "", assembly_key)
    if query_base and query_base == assembly_base:
        return 50
    return 0


def fetch_ncbi_assembly_name_accessions(
    assembly_names: Sequence[str],
    batch_size: int = 50,
) -> Dict[str, List[Dict[str, str]]]:
    queries = sorted({str(value or "").strip() for value in assembly_names if str(value or "").strip()})
    matches: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for index in range(0, len(queries), batch_size):
        batch = queries[index:index + batch_size]
        response = requests.post(
            NCBI_DATASET_REPORT_URL,
            json={"assembly_names": batch, "page_size": 1000, "returned_content": "COMPLETE"},
            timeout=30,
        )
        response.raise_for_status()
        records = [_ncbi_report_record(report) for report in (response.json().get("reports") or [])]
        records = [record for record in records if record.get("accession") and record.get("assembly_name")]
        for query in batch:
            query_key = normalize_assembly(query)
            scored = [
                (_assembly_query_score(query, record), record)
                for record in records
                if _assembly_query_score(query, record) > 0
            ]
            for _score, record in sorted(scored, key=lambda item: (-item[0], item[1].get("accession", ""))):
                if record not in matches[query_key]:
                    matches[query_key].append(record)
    return dict(matches)


def select_ncbi_assembly_record(
    assembly_name: str,
    taxon_id: str,
    records: Sequence[Dict[str, str]],
) -> Dict[str, str]:
    candidates = list(records or [])
    if taxon_id:
        taxon_matches = [record for record in candidates if record.get("taxon_id") == taxon_id]
        if taxon_matches:
            candidates = taxon_matches
    scored = [(_assembly_query_score(assembly_name, record), record) for record in candidates]
    scored = [(score, record) for score, record in scored if score > 0]
    if not scored:
        return {}
    best_score = max(score for score, _record in scored)
    best = [record for score, record in scored if score == best_score]

    def sort_key(record: Dict[str, str]) -> Tuple[int, int, int, str]:
        accession = record.get("accession", "")
        source = record.get("source_database", "").upper()
        status = record.get("assembly_status", "").lower()
        return (
            0 if accession.startswith("GCA_") else 1,
            0 if source == "GENBANK" else 1,
            0 if status == "current" else 1,
            accession,
        )

    return sorted(best, key=sort_key)[0]


def equivalent_accessions(accession: str, paired_accessions: Dict[str, str]) -> List[str]:
    paired = paired_accessions.get(accession)
    if paired and paired != accession:
        return [paired]
    return []


def accession_pair(primary_accession: str, equivalent_values: Sequence[str]) -> Tuple[str, str]:
    gca = ""
    gcf = ""
    for accession in [primary_accession, *list(equivalent_values or [])]:
        value = str(accession or "").strip()
        if value.startswith("GCA_") and not gca:
            gca = value
        elif value.startswith("GCF_") and not gcf:
            gcf = value
    return gca, gcf


def genome_to_manifest_side(
    genome: GenomeRow,
    endpoint: Optional[FileEndpoint],
    catalog_index: Dict[str, Any],
    paired_accessions: Dict[str, str],
    ncbi_assembly_accessions: Optional[Dict[str, List[Dict[str, str]]]] = None,
) -> Dict[str, Any]:
    catalog_matches, match_type = resolve_catalog_entries(genome, catalog_index)
    selected = catalog_matches[0] if len(catalog_matches) == 1 else {}
    ncbi_selected: Dict[str, str] = {}
    if not selected and ncbi_assembly_accessions:
        candidates = ncbi_assembly_accessions.get(normalize_assembly(genome.assembly), [])
        ncbi_selected = select_ncbi_assembly_record(genome.assembly, genome.taxon_id, candidates)
        if ncbi_selected:
            match_type = "ncbi_assembly_name"
    accession = selected.get("accession", "")
    if not accession:
        accession = ncbi_selected.get("accession", "")
    return {
        "file_token": endpoint.raw if endpoint else "",
        "file_species_abbrev": endpoint.species_abbrev if endpoint else "",
        "file_assembly_token": endpoint.assembly_token if endpoint else "",
        "genome_db_id": genome.genome_db_id,
        "name": genome.name,
        "assembly": genome.assembly,
        "taxon_id": genome.taxon_id,
        "genome_component": genome.genome_component,
        "strain_name": genome.strain_name,
        "display_name": genome.display_name,
        "first_release": genome.first_release,
        "last_release": genome.last_release,
        "catalog_match": match_type,
        "accession": accession,
        "equivalent_accessions": equivalent_accessions(accession, paired_accessions),
        "species_key": selected.get("species_key", ""),
        "scientific_name": selected.get("scientific_name", "") or ncbi_selected.get("scientific_name", ""),
        "common_name": selected.get("common_name", "") or ncbi_selected.get("common_name", ""),
        "catalog_assembly_name": selected.get("assembly_name", "") or ncbi_selected.get("assembly_name", ""),
        "catalog_match_count": len(catalog_matches),
        "catalog_match_accessions": [entry.get("accession", "") for entry in catalog_matches[:10]],
    }


def _find_endpoint_genome(endpoint: FileEndpoint, remaining_genomes: List[GenomeRow]) -> Optional[GenomeRow]:
    endpoint_assembly = normalize_assembly(endpoint.assembly_token)
    for index, genome in enumerate(remaining_genomes):
        if normalize_assembly(genome.assembly) == endpoint_assembly:
            return remaining_genomes.pop(index)
    return None


def build_alignment_rows(manifest: Dict[str, Any], release: int) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    for alignment in manifest.get("alignments") or []:
        sides = list(alignment.get("sides") or [])
        if len(sides) < 2:
            sides = [*sides, *({} for _ in range(2 - len(sides)))]
        side_1, side_2 = sides[:2]
        row: Dict[str, str] = {
            "release": str(release),
            "alignment_id": str(alignment.get("id") or ""),
            "method_link_species_set_id": str(alignment.get("method_link_species_set_id") or ""),
            "alignment_type": str(alignment.get("alignment_type") or ""),
            "mlss_name": str(alignment.get("mlss_name") or ""),
            "ftp_filename": str(alignment.get("filename") or ""),
            "ftp_url": str(alignment.get("url") or ""),
            "match_status": str(alignment.get("match_status") or ""),
            "warnings": " | ".join(str(item) for item in (alignment.get("warnings") or []) if item),
        }
        for prefix, side in (("species_1", side_1), ("species_2", side_2)):
            equivalent_values = side.get("equivalent_accessions") or []
            gca, gcf = accession_pair(str(side.get("accession") or ""), equivalent_values)
            species_name = (
                str(side.get("scientific_name") or "").strip()
                or str(side.get("display_name") or "").strip()
                or str(side.get("name") or "").replace("_", " ").strip()
            )
            row.update(
                {
                    f"{prefix}_species_name": species_name,
                    f"{prefix}_compara_name": str(side.get("name") or ""),
                    f"{prefix}_display_name": str(side.get("display_name") or ""),
                    f"{prefix}_common_name": str(side.get("common_name") or ""),
                    f"{prefix}_taxon_id": str(side.get("taxon_id") or ""),
                    f"{prefix}_genome_db_id": str(side.get("genome_db_id") or ""),
                    f"{prefix}_assembly_name": str(side.get("assembly") or ""),
                    f"{prefix}_catalog_assembly_name": str(side.get("catalog_assembly_name") or ""),
                    f"{prefix}_gca": gca,
                    f"{prefix}_gcf": gcf,
                    f"{prefix}_primary_accession": str(side.get("accession") or ""),
                    f"{prefix}_equivalent_accessions": ",".join(str(item) for item in equivalent_values if item),
                    f"{prefix}_species_key": str(side.get("species_key") or ""),
                    f"{prefix}_catalog_match": str(side.get("catalog_match") or ""),
                }
            )
        rows.append(row)
    return rows


def write_alignment_rows_tsv(path: Path, rows: Sequence[Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=ROW_FIELDNAMES, delimiter="\t", lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in ROW_FIELDNAMES})


def build_manifest(
    ftp_files: Sequence[FtpAlignmentFile],
    compara_rows: Sequence[GenomeRow],
    catalog: Dict[str, Any],
    release: int,
    ftp_url: str,
    paired_accessions: Optional[Dict[str, str]] = None,
    ncbi_assembly_accessions: Optional[Dict[str, List[Dict[str, str]]]] = None,
) -> Dict[str, Any]:
    catalog_index = build_catalog_index(catalog)
    compara_alignments = group_compara_rows(compara_rows)
    compara_index = build_compara_file_index(compara_alignments)
    paired = paired_accessions or {}

    alignments = []
    matched_mlss_ids = set()
    for ftp_file in ftp_files:
        endpoint_assembly_key = tuple(sorted(normalize_assembly(endpoint.assembly_token) for endpoint in ftp_file.endpoints))
        candidates = compara_index.get((ftp_file.method, endpoint_assembly_key), [])
        warnings: List[str] = []
        if not candidates:
            match_status = "no_compara_match"
            selected = None
            warnings.append("No Compara pair matched the filename method and assembly tokens.")
        elif len(candidates) > 1:
            match_status = "ambiguous_compara_match"
            selected = candidates[0]
            warnings.append(f"{len(candidates)} Compara pairs matched the filename; selected the first sorted match.")
        else:
            match_status = "matched"
            selected = candidates[0]

        sides: List[Dict[str, Any]] = []
        if selected:
            matched_mlss_ids.add(selected["method_link_species_set_id"])
            remaining_genomes = list(selected.get("genomes") or [])
            for endpoint in ftp_file.endpoints:
                genome = _find_endpoint_genome(endpoint, remaining_genomes)
                if genome:
                    sides.append(genome_to_manifest_side(genome, endpoint, catalog_index, paired, ncbi_assembly_accessions))
            for genome in remaining_genomes:
                sides.append(genome_to_manifest_side(genome, None, catalog_index, paired, ncbi_assembly_accessions))
        else:
            for endpoint in ftp_file.endpoints:
                placeholder = GenomeRow(
                    method_link_species_set_id="",
                    alignment_type=ftp_file.method,
                    mlss_name="",
                    genome_db_id="",
                    name="",
                    assembly=endpoint.assembly_token,
                )
                sides.append(genome_to_manifest_side(placeholder, endpoint, catalog_index, paired, ncbi_assembly_accessions))

        alignments.append(
            {
                "id": hashlib.sha1(ftp_file.filename.encode("utf-8")).hexdigest()[:12],
                "filename": ftp_file.filename,
                "url": ftp_file.url,
                "alignment_type": selected["alignment_type"] if selected else ftp_file.method,
                "method_link_species_set_id": selected["method_link_species_set_id"] if selected else "",
                "mlss_name": selected["mlss_name"] if selected else "",
                "match_status": match_status,
                "sides": sides,
                "warnings": warnings,
            }
        )

    by_accession: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for alignment in alignments:
        for side in alignment.get("sides") or []:
            accessions = [side.get("accession", ""), *(side.get("equivalent_accessions") or [])]
            for accession in [value for value in accessions if value]:
                by_accession[accession].append(
                    {
                        "alignment_id": alignment["id"],
                        "filename": alignment["filename"],
                        "url": alignment["url"],
                        "alignment_type": alignment["alignment_type"],
                        "method_link_species_set_id": alignment["method_link_species_set_id"],
                    }
                )

    status_counts = Counter(alignment["match_status"] for alignment in alignments)
    catalog_match_counts = Counter(
        side.get("catalog_match", "none")
        for alignment in alignments
        for side in (alignment.get("sides") or [])
    )
    unmatched_compara = [
        {
            "method_link_species_set_id": alignment["method_link_species_set_id"],
            "alignment_type": alignment["alignment_type"],
            "mlss_name": alignment["mlss_name"],
            "genomes": [
                {
                    "genome_db_id": genome.genome_db_id,
                    "name": genome.name,
                    "assembly": genome.assembly,
                    "taxon_id": genome.taxon_id,
                }
                for genome in alignment.get("genomes") or []
            ],
        }
        for alignment in compara_alignments
        if alignment["method_link_species_set_id"] not in matched_mlss_ids
    ]

    manifest = {
        "metadata": {
            "generated_at": now_iso_utc(),
            "release": release,
            "ftp_url": ftp_url,
            "ftp_file_count": len(ftp_files),
            "compara_pair_count": len(compara_alignments),
            "alignment_count": len(alignments),
            "match_status_counts": dict(sorted(status_counts.items())),
            "catalog_match_counts": dict(sorted(catalog_match_counts.items())),
        },
        "alignments": alignments,
        "by_accession": dict(sorted(by_accession.items())),
        "unmatched_compara": unmatched_compara,
    }
    manifest["alignment_rows"] = build_alignment_rows(manifest, release)
    return manifest


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate a JSON manifest that maps Ensembl pairwise MAF tarballs to Compara genomes and GCA/GCF accessions."
    )
    parser.add_argument("--release", type=int, default=DEFAULT_RELEASE)
    parser.add_argument("--ftp-url", default=DEFAULT_FTP_URL)
    parser.add_argument("--ftp-listing", default="", help="Optional saved FTP directory listing HTML for offline runs.")
    parser.add_argument("--catalog", default=str(DEFAULT_CATALOG_PATH), help="Species catalog JSON path.")
    parser.add_argument("--catalog-url", default=DEFAULT_CATALOG_URL, help="Catalog URL used when --catalog is absent.")
    parser.add_argument("--compara-tsv", default="", help="Detailed Compara TSV. If omitted, the mysql CLI is used.")
    parser.add_argument("--write-compara-tsv", default="", help="Optional path to save mysql query output TSV.")
    parser.add_argument("--mysql-host", default="ensembldb.ensembl.org")
    parser.add_argument("--mysql-port", type=int, default=5306)
    parser.add_argument("--mysql-user", default="anonymous")
    parser.add_argument("--mysql-database", default="", help="Defaults to ensembl_compara_<release>.")
    parser.add_argument("--mysql-program", default="mysql")
    parser.add_argument("--mysql-extra-arg", action="append", default=[], help="Extra argument passed to mysql; repeat as needed.")
    parser.add_argument(
        "--fetch-ncbi-equivalents",
        action="store_true",
        help="Use NCBI Datasets to fill missing assembly-name accessions and add paired GCA/GCF accessions.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output manifest path. Defaults to backend/cache/pairwise_alignment_manifest.release-<release>.json.",
    )
    parser.add_argument(
        "--rows-output",
        default="",
        help="Flat row TSV path for download-view ingestion. Defaults to backend/cache/pairwise_alignments.release-<release>.tsv.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    catalog_path = Path(args.catalog).expanduser() if args.catalog else None
    catalog = load_catalog(catalog_path, args.catalog_url)

    if args.ftp_listing:
        listing_html = Path(args.ftp_listing).expanduser().read_text(encoding="utf-8")
    else:
        listing_html = fetch_ftp_listing(args.ftp_url)
    ftp_files = parse_ftp_listing(listing_html, args.ftp_url)

    if args.compara_tsv:
        compara_rows = read_compara_tsv(Path(args.compara_tsv).expanduser())
    else:
        database = args.mysql_database or f"ensembl_compara_{args.release}"
        query = COMPARA_PAIRWISE_QUERY.format(release=args.release)
        mysql_output = run_mysql_query(
            query,
            host=args.mysql_host,
            port=args.mysql_port,
            user=args.mysql_user,
            database=database,
            mysql_program=args.mysql_program,
            extra_args=args.mysql_extra_arg,
        )
        if args.write_compara_tsv:
            Path(args.write_compara_tsv).expanduser().write_text(mysql_output, encoding="utf-8")
        temp_tsv = Path(args.write_compara_tsv).expanduser() if args.write_compara_tsv else None
        if temp_tsv:
            compara_rows = read_compara_tsv(temp_tsv)
        else:
            reader = csv.DictReader(mysql_output.splitlines(), delimiter="\t")
            compara_rows = [
                GenomeRow(
                    method_link_species_set_id=_first_value(row, "method_link_species_set_id"),
                    alignment_type=_first_value(row, "alignment_type", "type"),
                    mlss_name=_first_value(row, "mlss_name"),
                    genome_db_id=_first_value(row, "genome_db_id"),
                    name=_first_value(row, "name", "genome_name"),
                    assembly=_first_value(row, "assembly"),
                    taxon_id=_first_value(row, "taxon_id"),
                    genome_component=_first_value(row, "genome_component"),
                    strain_name=_first_value(row, "strain_name"),
                    display_name=_first_value(row, "display_name"),
                    first_release=_first_value(row, "first_release"),
                    last_release=_first_value(row, "last_release"),
                )
                for row in reader
            ]

    paired_accessions: Dict[str, str] = {}
    ncbi_assembly_accessions: Dict[str, List[Dict[str, str]]] = {}
    if args.fetch_ncbi_equivalents:
        catalog_index = build_catalog_index(catalog)
        accessions = []
        unresolved_assemblies = []
        for genome in compara_rows:
            matches, _match_type = resolve_catalog_entries(genome, catalog_index)
            if matches:
                accessions.extend(entry.get("accession", "") for entry in matches)
            else:
                unresolved_assemblies.append(genome.assembly)
        ncbi_assembly_accessions = fetch_ncbi_assembly_name_accessions(unresolved_assemblies)
        for records in ncbi_assembly_accessions.values():
            accessions.extend(record.get("accession", "") for record in records)
            accessions.extend(record.get("paired_accession", "") for record in records)
        paired_accessions = fetch_ncbi_paired_accessions(accessions)

    manifest = build_manifest(
        ftp_files=ftp_files,
        compara_rows=compara_rows,
        catalog=catalog,
        release=args.release,
        ftp_url=args.ftp_url,
        paired_accessions=paired_accessions,
        ncbi_assembly_accessions=ncbi_assembly_accessions,
    )

    output_path = Path(args.output).expanduser() if args.output else (
        BACKEND_ROOT / "cache" / f"pairwise_alignment_manifest.release-{args.release}.json"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    rows_output_path = Path(args.rows_output).expanduser() if args.rows_output else (
        BACKEND_ROOT / "cache" / f"pairwise_alignments.release-{args.release}.tsv"
    )
    write_alignment_rows_tsv(rows_output_path, manifest.get("alignment_rows") or [])

    print(json.dumps(manifest["metadata"], indent=2, sort_keys=True))
    print(f"Wrote {output_path}")
    print(f"Wrote {rows_output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
