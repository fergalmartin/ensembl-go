"""Protein structure lookup and genomic-to-structural coordinate mapping.

The Feature Explorer already knows a transcript's translation and, through
``translation.CdsSegment``, exactly which coding exon contributes which amino
acid.  What it cannot do on its own is find a three-dimensional model for that
protein or say which residue of the model a given exon lands on.

Two problems stand between the two coordinate systems:

1.  AlphaFold DB is keyed by UniProt accession, while the annotation the app
    reads gives Ensembl or RefSeq protein IDs.  ``resolve_uniprot_accession``
    walks a tier of sources to bridge that, preferring whatever is local.
2.  AlphaFold models the UniProt *canonical* sequence.  A transcript that is not
    the canonical isoform translates to something else, so residue *n* of the
    local translation is not residue *n* of the model.  ``build_residue_map``
    aligns the two and reports how well they actually correspond, so the caller
    can colour honestly rather than plausibly.

Deliberately free of FastAPI and of any network client: HTTP is injected by the
caller, which keeps the allowlist enforcement in one place and lets every rule
in here be tested without a socket.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

ALPHAFOLD_PREDICTION_URL = "https://alphafold.ebi.ac.uk/api/prediction/{accession}"
# A cross-reference search rather than the ID-mapping service: one GET with the
# answer in it, instead of submitting a job and polling for up to half a minute.
# It also reports whether each hit is reviewed, which the job API does not.
UNIPROT_SEARCH_URL = "https://rest.uniprot.org/uniprotkb/search"
UNIPROT_SEARCH_FIELDS = "accession,reviewed,length"

# UniProtKB accession grammar, plus an optional ``-N`` isoform suffix.
ACCESSION_RE = re.compile(
    r"^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})(?:-[0-9]+)?$"
)

# Where a resolved accession came from, most trusted first. Surfaced in the UI so
# a user can tell a curated cross-reference from a best-effort remote guess.
SOURCE_MANUAL = "manual"
SOURCE_CUSTOM_TSV = "custom_tsv"
SOURCE_XREF = "xref"
SOURCE_UNIPROT_API = "uniprot_api"

# SwissProt is manually reviewed; TrEMBL is not. When a cross-reference file
# offers both for one protein the reviewed entry is the better model target.
_REVIEWED_DB_HINTS = ("swissprot", "sptrembl")

MAX_MAPPING_TSV_BYTES = 64 * 1024 * 1024
MAX_MAPPING_ROWS = 2_000_000


def normalize_accession(value: Any) -> str:
    """Return ``value`` as a well-formed UniProt accession, or ``""``."""
    token = str(value or "").strip().upper()
    if not token or not ACCESSION_RE.match(token):
        return ""
    return token


def strip_id_version(value: Any) -> str:
    """``ENSP00000123456.2`` -> ``ENSP00000123456``."""
    token = str(value or "").strip()
    return token.split(".", 1)[0] if "." in token else token


def _index_keys(protein_id: str) -> Tuple[str, ...]:
    """Both the versioned and unversioned forms, so either side may carry a version."""
    token = str(protein_id or "").strip()
    if not token:
        return ()
    bare = strip_id_version(token)
    return (token,) if bare == token else (token, bare)


# ── Cross-reference files ─────────────────────────────────────────────────────


@dataclass
class UniProtMapping:
    """Protein ID -> UniProt accession, built from a TSV."""

    by_id: Dict[str, str] = field(default_factory=dict)
    row_count: int = 0
    matched_count: int = 0
    source_path: str = ""
    format: str = ""

    def lookup(self, protein_id: str) -> str:
        for key in _index_keys(protein_id):
            hit = self.by_id.get(key) or self.by_id.get(key.upper())
            if hit:
                return hit
        return ""


def _sniff_delimiter(sample: str) -> str:
    # Tab first: the Ensembl files are tab-separated and a description column may
    # legitimately contain commas.
    return "\t" if "\t" in sample.splitlines()[0] else ","


def parse_uniprot_mapping_tsv(
    text: str,
    *,
    source_path: str = "",
    max_rows: int = MAX_MAPPING_ROWS,
) -> UniProtMapping:
    """Read a protein-ID -> UniProt-accession table.

    Two shapes are accepted, distinguished by their header:

    ``ensembl_xref``
        An Ensembl cross-reference dump, with ``protein_stable_id``, ``xref`` and
        ``db_name`` columns among others. Only ``Uniprot/*`` rows are taken, and a
        reviewed (SwissProt) accession wins over an unreviewed one for the same
        protein.

    ``simple``
        Any two-column table of ``protein_id<TAB>accession``, with or without a
        header. This is the shape a user is likely to write by hand for their own
        annotation.
    """
    mapping = UniProtMapping(source_path=str(source_path or ""))
    stripped = text.lstrip("﻿")
    if not stripped.strip():
        return mapping

    delimiter = _sniff_delimiter(stripped)
    reader = csv.reader(io.StringIO(stripped), delimiter=delimiter)

    try:
        header = next(reader)
    except StopIteration:
        return mapping

    lowered = [str(cell or "").strip().lower() for cell in header]
    if "protein_stable_id" in lowered and "xref" in lowered:
        mapping.format = "ensembl_xref"
        return _parse_ensembl_xref(reader, lowered, mapping, max_rows)

    mapping.format = "simple"
    # A two-column file may or may not name its columns. If the first row already
    # looks like data, feed it back through rather than silently dropping a pair.
    if _looks_like_simple_row(header):
        _consume_simple_row(header, mapping)
    return _parse_simple(reader, mapping, max_rows)


def _looks_like_simple_row(row: Sequence[str]) -> bool:
    return len(row) >= 2 and bool(normalize_accession(row[1]))


def _consume_simple_row(row: Sequence[str], mapping: UniProtMapping) -> None:
    mapping.row_count += 1
    protein_id = str(row[0] or "").strip()
    accession = normalize_accession(row[1])
    if not protein_id or not accession:
        return
    for key in _index_keys(protein_id):
        mapping.by_id.setdefault(key.upper(), accession)
    mapping.matched_count += 1


def _parse_simple(reader, mapping: UniProtMapping, max_rows: int) -> UniProtMapping:
    for row in reader:
        if mapping.row_count >= max_rows:
            break
        if len(row) < 2:
            mapping.row_count += 1
            continue
        _consume_simple_row(row, mapping)
    return mapping


def _parse_ensembl_xref(reader, header: List[str], mapping: UniProtMapping, max_rows: int) -> UniProtMapping:
    try:
        protein_col = header.index("protein_stable_id")
        xref_col = header.index("xref")
    except ValueError:
        return mapping
    db_col = header.index("db_name") if "db_name" in header else -1

    # Track which rows came from a reviewed database so a later unreviewed row
    # cannot overwrite a reviewed accession.
    reviewed: Dict[str, bool] = {}

    for row in reader:
        if mapping.row_count >= max_rows:
            break
        mapping.row_count += 1
        if len(row) <= max(protein_col, xref_col):
            continue

        db_name = str(row[db_col] or "").strip().lower() if 0 <= db_col < len(row) else ""
        if db_col >= 0 and not db_name.startswith("uniprot"):
            continue

        protein_id = str(row[protein_col] or "").strip()
        accession = normalize_accession(row[xref_col])
        if not protein_id or not accession:
            continue

        is_reviewed = _REVIEWED_DB_HINTS[0] in db_name
        for key in _index_keys(protein_id):
            upper = key.upper()
            if upper in mapping.by_id and (reviewed.get(upper) or not is_reviewed):
                continue
            mapping.by_id[upper] = accession
            reviewed[upper] = is_reviewed
        mapping.matched_count += 1

    return mapping


def load_uniprot_mapping_file(path: Path, *, max_bytes: int = MAX_MAPPING_TSV_BYTES) -> UniProtMapping:
    """Read and parse a mapping file, transparently handling gzip."""
    resolved = Path(path)
    size = resolved.stat().st_size
    if size > max_bytes:
        raise ValueError(f"Mapping file is too large ({size} bytes, limit {max_bytes})")

    if resolved.suffix.lower() == ".gz":
        import gzip

        with gzip.open(resolved, "rt", encoding="utf-8", errors="replace") as handle:
            text = handle.read(max_bytes)
    else:
        text = resolved.read_text(encoding="utf-8", errors="replace")

    return parse_uniprot_mapping_tsv(text, source_path=str(resolved))


# ── UniProt cross-reference lookup ───────────────────────────────────────────────


def uniprot_search_params(protein_id: str) -> Dict[str, str]:
    """Query parameters that find the UniProt entries cross-referencing an ID."""
    return {
        "query": f"xref:{strip_id_version(protein_id)}",
        "fields": UNIPROT_SEARCH_FIELDS,
        "format": "json",
        "size": "10",
    }


def _is_reviewed(entry_type: Any) -> bool:
    # "UniProtKB unreviewed (TrEMBL)" contains "reviewed" as a substring, so the
    # negative has to be tested first.
    token = str(entry_type or "").lower()
    return "unreviewed" not in token and "reviewed" in token


def extract_search_accession(payload: Any, preferred_length: int = 0) -> str:
    """Choose the best accession from a UniProt cross-reference search.

    A protein ID often cross-references both a reviewed entry and one or more
    unreviewed ones. Preference goes to whichever entry's sequence is the same
    length as the translation we hold, because an exact-length match is the one
    that will map residue-for-residue; failing that, to the reviewed entry.
    """
    results = (payload or {}).get("results") if isinstance(payload, dict) else None
    candidates: List[Tuple[str, bool, int]] = []
    for item in results or []:
        if not isinstance(item, dict):
            continue
        accession = normalize_accession(item.get("primaryAccession"))
        if not accession:
            continue
        try:
            length = int(((item.get("sequence") or {}).get("length")) or 0)
        except (TypeError, ValueError):
            length = 0
        candidates.append((accession, _is_reviewed(item.get("entryType")), length))

    if not candidates:
        return ""

    if preferred_length > 0:
        for accession, _reviewed, length in candidates:
            if length == preferred_length:
                return accession

    for accession, reviewed, _length in candidates:
        if reviewed:
            return accession
    return candidates[0][0]


# ── AlphaFold DB metadata ─────────────────────────────────────────────────────


def _first(entry: Dict[str, Any], *names: str, default: Any = None) -> Any:
    """First present field among ``names``.

    AFDB renamed several prediction fields (``entryId`` -> ``modelEntityId``,
    ``uniprotSequence`` -> ``sequence``, ``uniprotStart``/``uniprotEnd`` ->
    ``sequenceStart``/``sequenceEnd``) and sunset the old names on 2026-06-25.
    New names are read first; the old ones remain accepted so a cached document
    or a mirror running behind does not break the panel.
    """
    for name in names:
        if name in entry and entry[name] not in (None, ""):
            return entry[name]
    return default


@dataclass
class AlphaFoldModel:
    accession: str = ""
    model_entity_id: str = ""
    sequence: str = ""
    sequence_start: int = 1
    sequence_end: int = 0
    version: int = 0
    cif_url: str = ""
    bcif_url: str = ""
    pdb_url: str = ""
    pae_doc_url: str = ""
    fragment_count: int = 1

    @property
    def is_fragmented(self) -> bool:
        return self.fragment_count > 1


def parse_alphafold_prediction(payload: Any, accession: str) -> Optional[AlphaFoldModel]:
    """Normalise an AFDB ``/api/prediction`` document into one model record.

    Very long proteins are predicted as overlapping fragments (``F1``, ``F2``,
    ...). Only the first is loaded here; ``fragment_count`` tells the caller how
    many exist so the UI can say the view is partial instead of implying it is
    the whole protein.
    """
    entries = payload if isinstance(payload, list) else [payload] if isinstance(payload, dict) else []
    entries = [entry for entry in entries if isinstance(entry, dict)]
    if not entries:
        return None

    entry = entries[0]
    sequence = str(_first(entry, "sequence", "uniprotSequence", default="") or "")
    if not sequence:
        # Nothing downstream can use a model with no sequence — there is nothing
        # to align a translation against and nothing to number residues by — so
        # an entry without one is no entry at all rather than a hollow record
        # that only fails later.
        return None
    try:
        version = int(_first(entry, "latestVersion", "modelVersion", default=0) or 0)
    except (TypeError, ValueError):
        version = 0

    def _coord(*names: str, default: int) -> int:
        try:
            return int(_first(entry, *names, default=default) or default)
        except (TypeError, ValueError):
            return default

    return AlphaFoldModel(
        accession=normalize_accession(_first(entry, "uniprotAccession", default=accession)) or accession,
        model_entity_id=str(_first(entry, "modelEntityId", "entryId", default="") or ""),
        sequence=sequence,
        sequence_start=_coord("sequenceStart", "uniprotStart", default=1),
        sequence_end=_coord("sequenceEnd", "uniprotEnd", default=len(sequence)),
        version=version,
        cif_url=str(_first(entry, "cifUrl", default="") or ""),
        bcif_url=str(_first(entry, "bcifUrl", default="") or ""),
        pdb_url=str(_first(entry, "pdbUrl", default="") or ""),
        pae_doc_url=str(_first(entry, "paeDocUrl", default="") or ""),
        fragment_count=len(entries),
    )


def model_cache_filename(accession: str, version: int, fragment: int = 1) -> str:
    """Stable on-disk name for a cached model, mirroring AFDB's own convention."""
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(accession or "")) or "unknown"
    suffix = f"v{int(version)}" if version else "vlatest"
    return f"AF-{safe}-F{max(1, int(fragment))}-model_{suffix}.cif"


# ── Exon -> residue mapping ───────────────────────────────────────────────────


def _segment_bounds(segment: Any) -> Tuple[int, int, int, int]:
    if isinstance(segment, dict):
        get = segment.get
    else:
        get = lambda name, default=None: getattr(segment, name, default)  # noqa: E731
    return (
        int(get("coord_start", 0) or 0),
        int(get("coord_end", 0) or 0),
        int(get("genomic_start", 0) or 0),
        int(get("genomic_end", 0) or 0),
    )


def assign_exon_per_residue(cds_segments: Sequence[Any]) -> List[int]:
    """Owning segment index for each amino acid, 1-based by position.

    A codon split across an intron belongs partly to two coding exons. For
    colouring, each residue has to pick one: the segment contributing the most
    bases wins, and an even split goes to the 5' segment. Returns a list whose
    index ``n - 1`` holds the segment index for amino acid ``n``, or ``-1`` where
    no segment covers it.
    """
    bounds = [_segment_bounds(segment) for segment in cds_segments]
    coord_max = max((end for _, end, _, _ in bounds), default=0)
    if coord_max <= 0:
        return []

    aa_count = (coord_max + 2) // 3
    owners = [-1] * aa_count
    for aa in range(1, aa_count + 1):
        codon_start = (aa - 1) * 3 + 1
        codon_end = codon_start + 2
        best_index = -1
        best_overlap = 0
        for index, (start, end, _, _) in enumerate(bounds):
            if start <= 0 or end < start:
                continue
            overlap = min(end, codon_end) - max(start, codon_start) + 1
            if overlap > best_overlap:
                best_overlap = overlap
                best_index = index
        owners[aa - 1] = best_index
    return owners


def aa_to_genomic(cds_segments: Sequence[Any], strand: str, aa_index: int) -> Optional[int]:
    """Genomic position of the first base of amino acid ``aa_index``.

    Mirrors ``getGenomicAnchor`` in the Proteins panel so the 2D and 3D views
    anchor residues to the same base.
    """
    cds_nt = (int(aa_index) - 1) * 3 + 1
    minus = str(strand or "+") == "-"
    for segment in cds_segments:
        start, end, genomic_start, genomic_end = _segment_bounds(segment)
        if start <= 0 or end < start:
            continue
        if start <= cds_nt <= end:
            offset = cds_nt - start
            return genomic_end - offset if minus else genomic_start + offset
    return None


_COMPLEMENT = str.maketrans("ACGTUNacgtun", "TGCAANtgcaan")


def reverse_complement(sequence: Any) -> str:
    """Reverse complement of a plain nucleotide string.

    Variant alleles in a VCF are always given on the forward strand, while the
    CDS of a minus-strand transcript is read the other way; the alleles have to
    be flipped before they can be substituted into a codon.
    """
    return str(sequence or "").translate(_COMPLEMENT)[::-1]


def genomic_to_cds_coord(
    cds_segments: Sequence[Any], strand: str, position: int
) -> Optional[int]:
    """CDS coordinate of a genomic position, or ``None`` when it is not coding.

    The inverse of :func:`aa_to_genomic`, in the same padded coordinate space, so
    ``(coord + 2) // 3`` is the amino acid the position belongs to.
    """
    minus = str(strand or "+") == "-"
    pos = int(position)
    for segment in cds_segments:
        start, end, genomic_start, genomic_end = _segment_bounds(segment)
        if start <= 0 or end < start:
            continue
        if genomic_start <= pos <= genomic_end:
            offset = (genomic_end - pos) if minus else (pos - genomic_start)
            return start + offset
    return None


def exon_index_for_coord(cds_segments: Sequence[Any], coord: int) -> int:
    """Index of the coding segment holding ``coord``, or ``-1``."""
    for index, segment in enumerate(cds_segments):
        start, end, _, _ = _segment_bounds(segment)
        if start <= 0 or end < start:
            continue
        if start <= int(coord) <= end:
            return index
    return -1


# Consequence terms are computed from the codon rather than read out of a CSQ or
# ANN field, so an unannotated VCF is as informative as an annotated one. The
# coarse impact is what the structure is coloured by: three classes a reader can
# tell apart at a glance, where the full term is available in the tooltip.
CONSEQUENCE_IMPACT = {
    "synonymous": "silent",
    "missense": "missense",
    "inframe_insertion": "missense",
    "inframe_deletion": "missense",
    "protein_altering": "missense",
    "stop_gained": "truncating",
    "stop_lost": "truncating",
    "start_lost": "truncating",
    "frameshift": "truncating",
}


def variant_impact(consequence: str) -> str:
    return CONSEQUENCE_IMPACT.get(str(consequence or ""), "other")


def classify_indel(ref_allele: str, alt_allele: str) -> str:
    """Consequence of a length-changing allele, from the frame shift alone."""
    delta = len(str(alt_allele or "")) - len(str(ref_allele or ""))
    if delta == 0:
        return "protein_altering"
    if delta % 3:
        return "frameshift"
    return "inframe_insertion" if delta > 0 else "inframe_deletion"


def classify_substitution(ref_aa: str, alt_aa: str, aa_index: int) -> str:
    """Consequence of a single-codon change, given both translated residues."""
    if not ref_aa or not alt_aa:
        return "protein_altering"
    if ref_aa == alt_aa:
        return "synonymous"
    if alt_aa == "*":
        return "stop_gained"
    if ref_aa == "*":
        return "stop_lost"
    if int(aa_index) == 1:
        return "start_lost"
    return "missense"


def align_local_to_model(
    local_seq: str,
    model_seq: str,
    align_fn: Optional[Callable[[str, str], Tuple[str, str]]] = None,
) -> Tuple[Dict[int, int], float, bool, int]:
    """Map local amino-acid index -> model residue index (both 1-based).

    Returns ``(mapping, identity, aligned, matches)``. When the two sequences are
    identical the mapping is the identity function and no aligner is invoked;
    otherwise ``align_fn`` (MAFFT, in production) supplies a pairwise alignment
    that is walked column by column.
    """
    local = str(local_seq or "")
    model = str(model_seq or "")
    if not local or not model:
        return {}, 0.0, False, 0

    if local == model:
        return {index: index for index in range(1, len(local) + 1)}, 1.0, False, len(local)

    if align_fn is None:
        return {}, 0.0, False, 0

    aligned_local, aligned_model = align_fn(local, model)
    if not aligned_local or not aligned_model or len(aligned_local) != len(aligned_model):
        return {}, 0.0, True, 0

    mapping: Dict[int, int] = {}
    local_index = 0
    model_index = 0
    matches = 0
    both = 0
    for left, right in zip(aligned_local.upper(), aligned_model.upper()):
        if left != "-":
            local_index += 1
        if right != "-":
            model_index += 1
        if left == "-" or right == "-":
            continue
        both += 1
        mapping[local_index] = model_index
        if left == right:
            matches += 1

    identity = (matches / both) if both else 0.0
    return mapping, identity, True, matches


@dataclass
class ResidueSegment:
    """One run of residues that a single coding exon contributes to the model."""

    exon_index: int
    aa_start: int
    aa_end: int
    model_start: int
    model_end: int
    genomic_start: Optional[int] = None
    genomic_end: Optional[int] = None


@dataclass
class ResidueMap:
    segments: List[ResidueSegment] = field(default_factory=list)
    identical: bool = False
    aligned: bool = False
    identity: float = 0.0
    coverage: float = 0.0
    local_length: int = 0
    model_length: int = 0
    exon_count: int = 0
    unmapped_residues: int = 0
    warnings: List[str] = field(default_factory=list)


def build_residue_map(
    local_seq: str,
    model: AlphaFoldModel,
    cds_segments: Sequence[Any],
    strand: str = "+",
    align_fn: Optional[Callable[[str, str], Tuple[str, str]]] = None,
) -> ResidueMap:
    """Project each coding exon onto a contiguous run of model residues.

    The result is what the viewer colours with. Runs are split wherever the
    alignment is not contiguous in model space, so an exon interrupted by an
    insertion in the model yields two ranges rather than one range that silently
    paints over the gap.
    """
    local = str(local_seq or "")
    model_seq = str(model.sequence or "")
    result = ResidueMap(local_length=len(local), model_length=len(model_seq))

    if not local:
        result.warnings.append("No local translation available for this transcript.")
        return result
    if not model_seq:
        result.warnings.append("The AlphaFold entry carries no sequence to align against.")
        return result

    mapping, identity, aligned, _matches = align_local_to_model(local, model_seq, align_fn)
    result.identity = identity
    result.aligned = aligned
    result.identical = local == model_seq

    if not mapping:
        result.warnings.append(
            "Could not align the transcript translation to the model sequence."
            if aligned else
            "No aligner available to reconcile the transcript translation with the model."
        )
        return result

    result.coverage = len(mapping) / len(local)
    result.unmapped_residues = len(local) - len(mapping)

    owners = assign_exon_per_residue(cds_segments)
    if not owners:
        result.warnings.append("Transcript has no coding segments to project.")
        return result
    result.exon_count = len({index for index in owners if index >= 0})

    # AFDB fragments start at sequenceStart within the full UniProt sequence.
    offset = max(0, int(model.sequence_start or 1) - 1)

    limit = min(len(local), len(owners))
    current: Optional[ResidueSegment] = None
    for aa in range(1, limit + 1):
        exon_index = owners[aa - 1]
        model_residue = mapping.get(aa)
        if exon_index < 0 or model_residue is None:
            current = None
            continue
        model_residue += offset

        contiguous = (
            current is not None
            and current.exon_index == exon_index
            and model_residue == current.model_end + 1
            and aa == current.aa_end + 1
        )
        if contiguous:
            current.aa_end = aa
            current.model_end = model_residue
            continue

        current = ResidueSegment(
            exon_index=exon_index,
            aa_start=aa,
            aa_end=aa,
            model_start=model_residue,
            model_end=model_residue,
        )
        result.segments.append(current)

    for segment in result.segments:
        segment.genomic_start = aa_to_genomic(cds_segments, strand, segment.aa_start)
        segment.genomic_end = aa_to_genomic(cds_segments, strand, segment.aa_end)

    if model.is_fragmented:
        result.warnings.append(
            f"AlphaFold splits this protein into {model.fragment_count} fragments; "
            "only the first is shown."
        )
    if not result.identical:
        result.warnings.append(
            f"This transcript's translation differs from the modelled UniProt sequence "
            f"({identity * 100:.0f}% identity, {result.unmapped_residues} residues unmapped)."
        )

    return result
