"""CDS → protein translation rules.

Deliberately free of FastAPI / SQLite / pysam imports so the rules below can be
unit tested directly and reused by ``backend/scripts/validate_translations.py``.

Conventions implemented here match the Ensembl protein FASTA (``pep.fa``) and the
NCBI/RefSeq protein records, which are the sources of truth we test against:

* CDS fragments are concatenated in biological 5'→3' order.
* The GFF3 ``phase`` of the 5'-most CDS fragment says how many of its leading
  bases belong to a codon that started outside the annotated CDS (a 5'-incomplete
  CDS, e.g. Ensembl ``cds_start_NF``).  Those bases must be skipped before
  translating, and the incomplete codon is reported as a single ``X``.  Ignoring
  the phase shifts the whole reading frame — the single largest source of
  visibly broken proteins.
* A trailing incomplete codon (3'-incomplete CDS) is dropped, not padded.
* A terminal stop is stripped; internal stops are kept, because they are real
  information about the annotation (readthrough, wrong frame, mis-annotation).
* An initiation codon that is valid for the genetic code in use is reported as
  ``M`` even when the codon is not ATG (e.g. mitochondrial ATT, bacterial GTG).
* Non-nuclear contigs use their own genetic code (vertebrate mitochondria =
  NCBI table 2, plant plastids = table 11, …), selected from the species
  lineage.  Translating mitochondrial genes with the standard code is the other
  large source of broken proteins: TGA reads as a stop instead of Trp.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from Bio.Data import CodonTable
from Bio.Seq import Seq

# ── genetic-code identifiers (NCBI translation table numbers) ─────────────────

TABLE_STANDARD = 1
TABLE_VERTEBRATE_MITO = 2
TABLE_YEAST_MITO = 3
TABLE_MOLD_PROTOZOAN_MITO = 4
TABLE_INVERTEBRATE_MITO = 5
TABLE_CILIATE_NUCLEAR = 6
TABLE_ECHINODERM_MITO = 9
TABLE_BACTERIAL_PLASTID = 11
TABLE_ASCIDIAN_MITO = 13
TABLE_TREMATODE_MITO = 21

# ── contig molecule classification ───────────────────────────────────────────

MOLECULE_NUCLEAR = "nuclear"
MOLECULE_MITOCHONDRION = "mitochondrion"
MOLECULE_PLASTID = "plastid"

# Contig names that mean "this is the organelle genome".  Only used when the
# assembly report does not tell us the molecule type (it does for every genome
# downloaded from Ensembl or NCBI, so this is mostly a manual-genome path).
_MITO_CONTIG_NAMES = {
    "mt", "m", "mtdna", "mito", "mitochondrion", "mitochondrial",
    "mitochondrion_genome", "mitochondrial_genome", "mitochondriongenome",
    "mtgenome", "chrmt", "chrm", "mt_genome", "mitogenome",
}
_PLASTID_CONTIG_NAMES = {
    "pt", "pltd", "plastid", "chloroplast", "chrpt", "chrpltd", "cp",
    "chloroplast_genome", "plastid_genome", "chrc",
}


def _normalize_contig_token(name: Any) -> str:
    token = str(name or "").strip().lower()
    if token.startswith("chr") and token not in {"chrm", "chrmt", "chrpt", "chrpltd", "chrc"}:
        token = token[3:]
    return re.sub(r"[^a-z0-9_]+", "", token)


def classify_contig_molecule(name: Any, reported_molecule_type: Any = "") -> str:
    """Classify a contig as nuclear / mitochondrial / plastid.

    ``reported_molecule_type`` is the assembly-report
    ``Assigned-Molecule-Location/Type`` value when we have one; it wins over the
    name heuristic because it is authoritative for accessioned contigs such as
    RefSeq's ``NC_012920.1``.
    """
    reported = str(reported_molecule_type or "").strip().lower()
    if reported:
        if "mitochondri" in reported:
            return MOLECULE_MITOCHONDRION
        if "plastid" in reported or "chloroplast" in reported:
            return MOLECULE_PLASTID
        if reported not in {"", "na", "n/a"}:
            return MOLECULE_NUCLEAR

    token = _normalize_contig_token(name)
    if token in _MITO_CONTIG_NAMES:
        return MOLECULE_MITOCHONDRION
    if token in _PLASTID_CONTIG_NAMES:
        return MOLECULE_PLASTID
    return MOLECULE_NUCLEAR


# ── lineage → genetic code ───────────────────────────────────────────────────
#
# Ordered most-specific-first; the first ancestor found in the lineage wins.
# Taxids are NCBI taxonomy ids, as carried by backend/data/taxonomy_classification.json.

_MITO_LINEAGE_RULES: Tuple[Tuple[int, int], ...] = (
    (6178, TABLE_TREMATODE_MITO),            # Trematoda (before Platyhelminthes)
    (7713, TABLE_ASCIDIAN_MITO),             # Ascidiacea (before Metazoa)
    (7586, TABLE_ECHINODERM_MITO),           # Echinodermata
    (6157, TABLE_ECHINODERM_MITO),           # Platyhelminthes
    (6073, TABLE_MOLD_PROTOZOAN_MITO),       # Cnidaria ("coelenterate" code)
    (6040, TABLE_MOLD_PROTOZOAN_MITO),       # Porifera
    (7742, TABLE_VERTEBRATE_MITO),           # Vertebrata (before Metazoa)
    (33208, TABLE_INVERTEBRATE_MITO),        # Metazoa: everything else
    (4893, TABLE_YEAST_MITO),                # Saccharomycetaceae (before Fungi)
    (4751, TABLE_MOLD_PROTOZOAN_MITO),       # Fungi
    (33090, TABLE_STANDARD),                 # Viridiplantae: plant mitochondria
    (2763, TABLE_MOLD_PROTOZOAN_MITO),       # Rhodophyta
    (5794, TABLE_MOLD_PROTOZOAN_MITO),       # Apicomplexa
    (33630, TABLE_MOLD_PROTOZOAN_MITO),      # Alveolata
    (33682, TABLE_MOLD_PROTOZOAN_MITO),      # Euglenozoa
    (554915, TABLE_MOLD_PROTOZOAN_MITO),     # Amoebozoa
)

_NUCLEAR_LINEAGE_RULES: Tuple[Tuple[int, int], ...] = (
    (2085, TABLE_MOLD_PROTOZOAN_MITO),       # Mycoplasmatales (before Bacteria)
    (2131, TABLE_MOLD_PROTOZOAN_MITO),       # Entomoplasmatales
    (5878, TABLE_CILIATE_NUCLEAR),           # Ciliophora: TAA/TAG encode Gln
    (35164, TABLE_CILIATE_NUCLEAR),          # Dasycladaceae
    (5786, TABLE_CILIATE_NUCLEAR),           # Hexamitidae
    (2, TABLE_BACTERIAL_PLASTID),            # Bacteria
    (2157, TABLE_BACTERIAL_PLASTID),         # Archaea
)

# Tried in order when the lineage is unknown and the contig is an organelle.
_ORGANELLE_FALLBACK_TABLES: Tuple[int, ...] = (
    TABLE_VERTEBRATE_MITO,
    TABLE_INVERTEBRATE_MITO,
    TABLE_MOLD_PROTOZOAN_MITO,
    TABLE_YEAST_MITO,
    TABLE_ECHINODERM_MITO,
    TABLE_BACTERIAL_PLASTID,
    TABLE_STANDARD,
)

# Known limitations, deliberately not guessed at:
#   * CTG-clade yeasts (Candida albicans and relatives) use nuclear table 12.
#     Their lineage anchor is not stable enough to key on safely, so they fall
#     back to the standard code (one Ser/Leu difference per CTG codon).
#   * Selenocysteine (U) and pyrrolysine (O) recoding is annotation-driven
#     (RefSeq ``transl_except``); we translate the codon as a stop, matching
#     neither pep file at that single residue.


def translation_table_for_lineage(molecule: str, lineage: Optional[Iterable[int]]) -> Optional[int]:
    """Genetic code for *molecule* given an NCBI lineage, or ``None`` if unknown.

    ``None`` means "no rule matched" — callers decide whether to fall back to the
    standard code (nuclear) or to auto-detection (organelles).
    """
    ids = {int(value) for value in (lineage or []) if int(value or 0)}
    if molecule == MOLECULE_PLASTID:
        return TABLE_BACTERIAL_PLASTID
    rules = _MITO_LINEAGE_RULES if molecule == MOLECULE_MITOCHONDRION else _NUCLEAR_LINEAGE_RULES
    for taxid, table in rules:
        if taxid in ids:
            return table
    if molecule == MOLECULE_MITOCHONDRION:
        return None
    return TABLE_STANDARD if ids else None


# ── CDS layout ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CdsSegment:
    """One CDS fragment in codon-aligned CDS coordinates.

    ``coord_start``/``coord_end`` are 1-based positions in a coordinate space
    where amino acid *n* always occupies positions ``3n-2 .. 3n``.  When the CDS
    is 5'-incomplete the space is padded on the left by ``(3 - phase) % 3``
    virtual bases, so clients can keep using ``floor((nt - 1) / 3) + 1`` to map a
    CDS nucleotide to its amino acid.
    """

    coord_start: int
    coord_end: int
    genomic_start: int
    genomic_end: int
    phase: Optional[int] = None


@dataclass(frozen=True)
class TranslationLayout:
    segments: Tuple[CdsSegment, ...] = ()
    start_phase: int = 0          # phase of the 5'-most CDS fragment
    pad: int = 0                  # (3 - start_phase) % 3 virtual leading bases
    cds_length: int = 0           # total annotated CDS bases (5'→3')
    dropped_trailing: int = 0     # bases in the trailing incomplete codon

    @property
    def coord_max(self) -> int:
        return self.segments[-1].coord_end if self.segments else 0

    @property
    def five_prime_partial(self) -> bool:
        return self.start_phase > 0

    @property
    def three_prime_partial(self) -> bool:
        return self.dropped_trailing > 0


def _coerce_phase(value: Any) -> Optional[int]:
    if value in (0, 1, 2):
        return int(value)
    try:
        phase = int(str(value).strip())
    except Exception:
        return None
    return phase if phase in (0, 1, 2) else None


def normalize_cds_intervals(cds_list: Any, strand: str) -> List[Dict[str, Any]]:
    """Positive-coordinate CDS intervals, deduplicated, in biological 5'→3' order.

    Exact duplicates are dropped: a hand-edited or merged GFF can list the same
    CDS line twice, which would otherwise double those bases and break the frame.
    """
    seen: Dict[Tuple[int, int], Dict[str, Any]] = {}
    for item in (cds_list or []):
        if not isinstance(item, dict):
            continue
        try:
            start = int(item.get("start", 0) or 0)
            end = int(item.get("end", 0) or 0)
        except Exception:
            continue
        if start <= 0 or end <= 0:
            continue
        if end < start:
            start, end = end, start
        key = (start, end)
        if key in seen:
            # Keep a declared phase if the duplicate carries one.
            if seen[key].get("phase") is None:
                seen[key]["phase"] = _coerce_phase(item.get("phase"))
            continue
        seen[key] = {"start": start, "end": end, "phase": _coerce_phase(item.get("phase"))}

    ordered = sorted(seen.values(), key=lambda seg: (seg["start"], seg["end"]))
    if str(strand or "+") == "-":
        ordered.reverse()
    return ordered


def build_translation_layout(cds_list: Any, strand: str) -> TranslationLayout:
    """Codon-aligned segments for the translated part of a CDS."""
    ordered = normalize_cds_intervals(cds_list, strand)
    if not ordered:
        return TranslationLayout()

    minus = str(strand or "+") == "-"
    start_phase = ordered[0].get("phase") or 0
    pad = (3 - start_phase) % 3
    cds_length = sum(seg["end"] - seg["start"] + 1 for seg in ordered)

    # Bases left after skipping the leading incomplete codon, rounded down to a
    # whole number of codons; the trailing remainder is dropped.
    translated = max(0, cds_length - start_phase)
    dropped_trailing = translated % 3

    segments: List[CdsSegment] = []
    cursor = pad + 1
    for seg in ordered:
        seg_len = seg["end"] - seg["start"] + 1
        segments.append(CdsSegment(
            coord_start=cursor,
            coord_end=cursor + seg_len - 1,
            genomic_start=seg["start"],
            genomic_end=seg["end"],
            phase=seg.get("phase"),
        ))
        cursor += seg_len

    if dropped_trailing:
        segments = _trim_trailing_bases(segments, dropped_trailing, minus)

    return TranslationLayout(
        segments=tuple(segments),
        start_phase=start_phase,
        pad=pad,
        cds_length=cds_length,
        dropped_trailing=dropped_trailing,
    )


def _trim_trailing_bases(segments: List[CdsSegment], count: int, minus: bool) -> List[CdsSegment]:
    """Remove *count* bases from the 3' end so segments cover whole codons only."""
    out = list(segments)
    while count > 0 and out:
        last = out[-1]
        span = last.coord_end - last.coord_start + 1
        take = min(count, span)
        count -= take
        if take == span:
            out.pop()
            continue
        out[-1] = CdsSegment(
            coord_start=last.coord_start,
            coord_end=last.coord_end - take,
            # The 3' end is the high coordinate on +, the low coordinate on -.
            genomic_start=last.genomic_start + take if minus else last.genomic_start,
            genomic_end=last.genomic_end if minus else last.genomic_end - take,
            phase=last.phase,
        )
    return out


# ── translation ──────────────────────────────────────────────────────────────


def _codon_table(table: int) -> CodonTable.CodonTable:
    try:
        return CodonTable.unambiguous_dna_by_id[int(table)]
    except Exception:
        return CodonTable.unambiguous_dna_by_id[TABLE_STANDARD]


def is_start_codon(codon: str, table: int = TABLE_STANDARD) -> bool:
    return str(codon or "").upper() in set(_codon_table(table).start_codons)


def internal_stop_count(protein: str) -> int:
    """Stops that are not the terminal residue."""
    body = protein[:-1] if protein.endswith("*") else protein
    return body.count("*")


def translate_cds_dna(
    dna: str,
    start_phase: int = 0,
    table: int = TABLE_STANDARD,
    force_start_met: bool = True,
) -> str:
    """Translate concatenated 5'→3' CDS bases.

    ``start_phase`` bases are skipped from the 5' end and, when non-zero,
    reported as a leading ``X`` for the codon that began outside the CDS.
    """
    sequence = re.sub(r"\s+", "", str(dna or "")).upper()
    phase = start_phase if start_phase in (0, 1, 2) else 0
    body = sequence[phase:]
    remainder = len(body) % 3
    if remainder:
        body = body[: len(body) - remainder]
    if not body:
        return "X" if phase and sequence else ""

    try:
        protein = str(Seq(body).translate(table=int(table), to_stop=False))
    except Exception:
        # Ambiguity codes outside IUPAC (or an unknown table) — normalise and retry.
        cleaned = re.sub(r"[^ACGTUMRWSYKVHDBN]", "N", body)
        try:
            protein = str(Seq(cleaned).translate(table=int(table), to_stop=False))
        except Exception:
            protein = str(Seq(re.sub(r"[^ACGTU]", "N", body)).translate(to_stop=False))

    if protein.endswith("*"):
        protein = protein[:-1]

    if phase == 0 and force_start_met and protein and protein[0] != "M" and is_start_codon(body[:3], table):
        # NCBI/Ensembl render any valid initiation codon as Met (mitochondrial
        # ATT, bacterial GTG, …).
        protein = "M" + protein[1:]

    if phase:
        protein = "X" + protein
    return protein


def autodetect_organelle_table(
    dna: str,
    start_phase: int = 0,
    candidates: Sequence[int] = _ORGANELLE_FALLBACK_TABLES,
) -> int:
    """Pick the organelle genetic code that leaves the fewest internal stops.

    Only used for organelle contigs of genomes whose lineage we cannot resolve
    (typically a manually imported genome).  Mitochondrial genes are long enough
    that the wrong code produces many internal stops and the right one produces
    none, so this is a reliable tie-break rather than a guess.
    """
    best_table = candidates[0] if candidates else TABLE_STANDARD
    best_score = None
    for table in candidates:
        protein = translate_cds_dna(dna, start_phase=start_phase, table=table, force_start_met=False)
        if not protein:
            continue
        score = internal_stop_count(protein)
        if score == 0:
            return table
        if best_score is None or score < best_score:
            best_score, best_table = score, table
    return best_table
