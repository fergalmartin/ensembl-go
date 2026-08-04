import gzip
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


_INVALID_ALIAS_VALUES = {"", "na", "n/a", "null", "-"}


@dataclass(frozen=True)
class AssemblyReportRow:
    row_index: int
    sequence_name: str
    assigned_molecule: str
    genbank_accession: str
    refseq_accession: str
    ucsc_style_name: str
    sequence_role: str
    # "Assigned-Molecule-Location/Type": Chromosome | Mitochondrion | Plastid | ...
    molecule_type: str = ""

    @property
    def is_assembled_molecule(self) -> bool:
        return self.sequence_role.strip().lower() == "assembled-molecule"

    def ordered_aliases(self) -> List[str]:
        out: List[str] = []
        for value in (
            self.sequence_name,
            self.assigned_molecule,
            self.genbank_accession,
            self.refseq_accession,
            self.ucsc_style_name,
        ):
            if not _is_valid_alias(value):
                continue
            if value not in out:
                out.append(value)
        return out


def _is_valid_alias(value: str) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    return text.lower() not in _INVALID_ALIAS_VALUES


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


def extract_ncbi_assembly_dirs_from_listing(listing_html: str) -> List[str]:
    hrefs = re.findall(r'href="([^"]+)"', listing_html or "")
    directories: List[str] = []
    for href in hrefs:
        value = str(href or "").strip()
        if not value.endswith("/"):
            continue
        name = value.strip("/")
        if name.startswith("GCA_"):
            directories.append(name)
    return directories


def select_ncbi_assembly_dir(
    directories: Sequence[str],
    stem: str,
    version: Optional[str],
    full_accession: Optional[str],
) -> Optional[str]:
    values = [str(x or "").strip() for x in directories if str(x or "").strip()]
    if not values:
        return None

    if full_accession:
        wanted_prefix = f"{full_accession}_"
        for name in values:
            if name.startswith(wanted_prefix):
                return name

    if version and stem:
        generic_prefix = f"{stem}."
        for name in values:
            if name.startswith(generic_prefix):
                return name

    return sorted(values)[-1]


def _normalize_header_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


def _parse_assembly_report_header(line: str) -> List[str]:
    payload = line[1:].strip() if line.startswith("#") else str(line or "").strip()
    columns = [str(col or "").strip() for col in payload.split("\t")]
    return [_normalize_header_name(col) for col in columns]


def _row_value(row: Dict[str, str], *keys: str) -> str:
    for key in keys:
        if key in row:
            return str(row.get(key) or "").strip()
    return ""


def parse_assembly_report_file(path: str) -> List[AssemblyReportRow]:
    fp = Path(path)
    if not fp.exists() or not fp.is_file():
        return []

    rows: List[AssemblyReportRow] = []
    header: List[str] = []
    with _open_text_maybe_gzip(fp) as handle:
        for line in handle:
            raw = line.rstrip("\n")
            if not raw:
                continue

            if raw.startswith("#"):
                maybe_header = _parse_assembly_report_header(raw)
                if "sequence_name" in maybe_header and "sequence_role" in maybe_header:
                    header = maybe_header
                continue

            if not header:
                continue

            values = raw.split("\t")
            mapped = {header[i]: (values[i].strip() if i < len(values) else "") for i in range(len(header))}
            row = AssemblyReportRow(
                row_index=len(rows),
                sequence_name=_row_value(mapped, "sequence_name"),
                assigned_molecule=_row_value(mapped, "assigned_molecule"),
                genbank_accession=_row_value(mapped, "genbank_accn", "genbank_accession"),
                refseq_accession=_row_value(mapped, "refseq_accn", "refseq_accession"),
                ucsc_style_name=_row_value(mapped, "ucsc_style_name"),
                sequence_role=_row_value(mapped, "sequence_role"),
                molecule_type=_row_value(mapped, "assigned_molecule_location_type"),
            )
            rows.append(row)
    return rows


def _open_text_maybe_gzip(path: Path):
    if str(path.name).lower().endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def parse_sequence_report_file(path: str) -> List[AssemblyReportRow]:
    fp = Path(path)
    if not fp.exists() or not fp.is_file():
        return []

    rows: List[AssemblyReportRow] = []
    try:
        with _open_text_maybe_gzip(fp) as handle:
            first = handle.read(1)
            handle.seek(0)
            if first == "{":
                payload = json.load(handle)
                reports = payload.get("reports") or []
                for idx, report in enumerate(reports):
                    if not isinstance(report, dict):
                        continue
                    rows.append(
                        AssemblyReportRow(
                            row_index=len(rows),
                            sequence_name=str(report.get("sequence_name") or "").strip(),
                            assigned_molecule=str(report.get("chr_name") or "").strip(),
                            genbank_accession=str(report.get("genbank_accession") or "").strip(),
                            refseq_accession=str(report.get("refseq_accession") or "").strip(),
                            ucsc_style_name=str(report.get("ucsc_style_name") or "").strip(),
                            sequence_role=str(report.get("role") or "").strip(),
                            molecule_type=str(report.get("assigned_molecule_location_type") or "").strip(),
                        )
                    )
                return rows

            if first == "[":
                payload = json.load(handle)
                for idx, report in enumerate(payload):
                    if not isinstance(report, dict):
                        continue
                    rows.append(
                        AssemblyReportRow(
                            row_index=len(rows),
                            sequence_name=str(report.get("sequence_name") or "").strip(),
                            assigned_molecule=str(report.get("chr_name") or "").strip(),
                            genbank_accession=str(report.get("genbank_accession") or "").strip(),
                            refseq_accession=str(report.get("refseq_accession") or "").strip(),
                            ucsc_style_name=str(report.get("ucsc_style_name") or "").strip(),
                            sequence_role=str(report.get("role") or "").strip(),
                            molecule_type=str(report.get("assigned_molecule_location_type") or "").strip(),
                        )
                    )
                return rows

            header: List[str] = []
            for line in handle:
                raw = line.rstrip("\n")
                if not raw:
                    continue
                stripped = raw.strip()
                if stripped.startswith("{"):
                    try:
                        report = json.loads(stripped)
                    except Exception:
                        continue
                    if not isinstance(report, dict):
                        continue
                    rows.append(
                        AssemblyReportRow(
                            row_index=len(rows),
                            sequence_name=str(report.get("sequence_name") or "").strip(),
                            assigned_molecule=str(report.get("chr_name") or "").strip(),
                            genbank_accession=str(report.get("genbank_accession") or "").strip(),
                            refseq_accession=str(report.get("refseq_accession") or "").strip(),
                            ucsc_style_name=str(report.get("ucsc_style_name") or "").strip(),
                            sequence_role=str(report.get("role") or "").strip(),
                            molecule_type=str(report.get("assigned_molecule_location_type") or "").strip(),
                        )
                    )
                    continue

                if not header:
                    header = _parse_assembly_report_header(raw)
                    continue

                values = raw.split("\t")
                mapped = {header[i]: (values[i].strip() if i < len(values) else "") for i in range(len(header))}
                rows.append(
                    AssemblyReportRow(
                        row_index=len(rows),
                        sequence_name=_row_value(mapped, "sequence_name"),
                        assigned_molecule=_row_value(mapped, "chr_name", "assigned_molecule"),
                        genbank_accession=_row_value(mapped, "genbank_accession", "genbank_accn"),
                        refseq_accession=_row_value(mapped, "refseq_accession", "refseq_accn"),
                        ucsc_style_name=_row_value(mapped, "ucsc_style_name"),
                        sequence_role=_row_value(mapped, "role", "sequence_role"),
                        molecule_type=_row_value(mapped, "assigned_molecule_location_type"),
                    )
                )
    except Exception:
        return []
    return rows


def load_assembly_synonym_rows(path: str) -> List[AssemblyReportRow]:
    rows = parse_assembly_report_file(path)
    if rows:
        return rows
    return parse_sequence_report_file(path)


def chrom_token_variants(token: str) -> Set[str]:
    text = str(token or "").strip()
    if not text:
        return set()

    lowered = text.lower()
    out: Set[str] = {lowered}

    if lowered.startswith("chr") and len(lowered) > 3:
        out.add(lowered[3:])
    else:
        out.add(f"chr{lowered}")

    if lowered in {"m", "mt", "chrm", "chrmt"}:
        out.update({"m", "mt", "chrm", "chrmt"})
    return out


def _build_known_token_map(known_regions: Iterable[str]) -> Dict[str, Set[str]]:
    token_map: Dict[str, Set[str]] = {}
    for region in known_regions:
        value = str(region or "").strip()
        if not value:
            continue
        for token in chrom_token_variants(value):
            token_map.setdefault(token, set()).add(value)
    return token_map


class KnownRegions:
    """The three lookups every region-name resolution needs, built once.

    A scaffold-level assembly brings hundreds of thousands of sequence names,
    and resolving a name used to scan all of them (and rebuild the token map)
    on each lookup. Since a synonym index performs a lookup per alias, that made
    /api/browse/regions quadratic: it never returned, the browser sat on
    "Building Index" waiting for it, and the polls that followed took a request
    thread each until the backend had none left to answer anything else with.
    """

    __slots__ = ("values", "lower_map", "token_map")

    def __init__(self, known_regions: Iterable[str]):
        self.values: Set[str] = {str(x or "").strip() for x in known_regions if str(x or "").strip()}
        lower_map: Dict[str, List[str]] = {}
        for value in self.values:
            lower_map.setdefault(value.lower(), []).append(value)
        self.lower_map = lower_map
        self.token_map = _build_known_token_map(self.values)

    def __bool__(self) -> bool:
        return bool(self.values)

    def __contains__(self, value: object) -> bool:
        return value in self.values

    def resolve(self, value: str) -> Optional[str]:
        text = str(value or "").strip()
        if not text:
            return None
        if text in self.values:
            return text

        direct_lower = self.lower_map.get(text.lower()) or []
        if len(direct_lower) == 1:
            return direct_lower[0]

        matches: Set[str] = set()
        for token in chrom_token_variants(text):
            matches.update(self.token_map.get(token, set()))
        if len(matches) == 1:
            return next(iter(matches))
        return None


def _as_known_regions(known_regions: Any) -> KnownRegions:
    return known_regions if isinstance(known_regions, KnownRegions) else KnownRegions(known_regions)


def _best_priority(left: Tuple[int, int], right: Tuple[int, int]) -> Tuple[int, int]:
    return left if left <= right else right


def build_synonym_index(
    report_rows: Sequence[AssemblyReportRow],
    known_regions: Iterable[str],
) -> Dict[str, Dict[str, List]]:
    known = _as_known_regions(known_regions)

    canonical_to_synonyms: Dict[str, Set[str]] = {}
    canonical_alias_pairs: List[Tuple[str, str]] = []
    alias_priority: Dict[str, Dict[str, Tuple[int, int]]] = {}

    for row in report_rows:
        aliases = row.ordered_aliases()
        if not aliases:
            continue

        canonical: Optional[str] = None
        for preferred in (
            row.sequence_name,
            row.refseq_accession,
            row.genbank_accession,
            row.ucsc_style_name,
            row.assigned_molecule,
        ):
            canonical = known.resolve(preferred)
            if canonical:
                break
        if not canonical:
            for alias in aliases:
                canonical = known.resolve(alias)
                if canonical:
                    break
        if not canonical:
            continue

        canonical_to_synonyms.setdefault(canonical, set())
        for alias in aliases:
            if alias.lower() != canonical.lower():
                canonical_alias_pairs.append((canonical, alias))

        base_priority = (0 if row.is_assembled_molecule else 1, row.row_index)
        for alias in aliases + [canonical]:
            for token in chrom_token_variants(alias):
                per_alias = alias_priority.setdefault(token, {})
                if canonical in per_alias:
                    per_alias[canonical] = _best_priority(per_alias[canonical], base_priority)
                else:
                    per_alias[canonical] = base_priority

    alias_to_candidates: Dict[str, List[Dict[str, object]]] = {}
    for token, mapped in alias_priority.items():
        ordered = sorted(
            (
                {
                    "canonical": canonical,
                    "is_assembled": priority[0] == 0,
                    "row_index": priority[1],
                }
                for canonical, priority in mapped.items()
            ),
            key=lambda item: (
                0 if item["is_assembled"] else 1,
                int(item["row_index"]),
                str(item["canonical"]).lower(),
            ),
        )
        alias_to_candidates[token] = ordered

    # Keep only aliases that resolve back to this canonical region under the same
    # deterministic resolver logic. This avoids exposing ambiguous aliases (for
    # example assigned-molecule values shared by unlocalized scaffolds) on
    # multiple regions in /api/browse/regions.
    for canonical, alias in canonical_alias_pairs:
        resolved = resolve_region_name(alias, known, alias_to_candidates)
        if resolved == canonical:
            canonical_to_synonyms.setdefault(canonical, set()).add(alias)

    return {
        "canonical_to_synonyms": {
            canonical: sorted(values)
            for canonical, values in canonical_to_synonyms.items()
        },
        "alias_to_candidates": alias_to_candidates,
    }


def resolve_region_name(
    requested: str,
    known_regions: Iterable[str],
    alias_to_candidates: Optional[Dict[str, List[Dict[str, object]]]] = None,
) -> Optional[str]:
    """Map a requested region name onto one the genome actually has.

    ``known_regions`` may be a plain iterable of names or a prepared
    :class:`KnownRegions`. Pass the prepared form when resolving more than one
    name against the same genome: building it walks every sequence in the
    assembly, which is not something to repeat per lookup.
    """
    known = _as_known_regions(known_regions)
    if not known:
        return None

    query = str(requested or "").strip()
    if not query:
        return None

    query_tokens = chrom_token_variants(query)
    direct = known.resolve(query)
    if direct is not None:
        return direct

    if not alias_to_candidates:
        return None
    known_set = known.values

    best: Optional[Tuple[int, int, int, str, str]] = None
    for token in query_tokens:
        for candidate in alias_to_candidates.get(token, []):
            canonical = str(candidate.get("canonical") or "").strip()
            if not canonical or canonical not in known_set:
                continue
            canonical_tokens = chrom_token_variants(canonical)
            canonical_match = 0 if canonical_tokens & query_tokens else 1
            score = (
                canonical_match,
                0 if bool(candidate.get("is_assembled")) else 1,
                int(candidate.get("row_index") or 0),
                canonical.lower(),
                canonical,
            )
            if best is None or score < best:
                best = score
    if best is None:
        return None
    return best[-1]
