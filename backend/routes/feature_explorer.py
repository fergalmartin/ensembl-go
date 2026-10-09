"""The Feature Explorer: per-gene exon states and aggregate statistics across
transcripts, exon detail with junctions and sequence, transcript sequence rows,
protein rows (translated through transcript_translation), and InterPro protein domains
looked up via UniProt.
"""

import json
import logging
import sqlite3
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import genome_context
import gff_index
import protein_structure
import routes.structure
import sequence_windows
import transcript_translation
from translation import TABLE_STANDARD, TranslationLayout

router = APIRouter()


class FeatureExplorerSequenceRowRequest(BaseModel):
    transcript_id: str
    window_start: int
    window_end: int


class FeatureExplorerSequencesRequest(BaseModel):
    genome: str = "reference"
    sequence_type: str = "genomic"  # genomic | transcript | cds
    rows: List[FeatureExplorerSequenceRowRequest]
    include_features: bool = True


class FeatureExplorerSequenceRowResponse(BaseModel):
    transcript_id: str
    status: str  # ok | no_cds | not_found | error
    message: Optional[str] = None
    chrom: str
    strand: str
    coord_min: int
    coord_max: int
    window_start: int
    window_end: int
    sequence: str
    features: List[sequence_windows.FeatureSlice] = []


class FeatureExplorerSequencesResponse(BaseModel):
    sequence_type: str
    rows: List[FeatureExplorerSequenceRowResponse]


class FeatureExplorerExonsSummaryRequest(BaseModel):
    genome: str = "reference"
    gene_id: str
    transcript_ids: Optional[List[str]] = None
    include_inactive: bool = False


class ExonSummaryGene(BaseModel):
    gene_id: str
    symbol: str = ""
    chrom: str = ""
    start: int = 0
    end: int = 0
    strand: str = "+"
    biotype: str = ""


class ExonSummaryTranscript(BaseModel):
    transcript_id: str
    biotype: str = ""
    is_canonical: bool = False
    is_active: bool = True


class ExonStateRecord(BaseModel):
    exon_state_key: str
    exon_label: str
    boundary_key: str
    chrom: str
    start: int
    end: int
    strand: str
    length: int
    state_class: str  # non_coding | partial_coding | coding
    coding_start: Optional[int] = None
    coding_end: Optional[int] = None
    coding_segments: List[Tuple[int, int]] = []
    transcript_ids: List[str] = []
    transcript_states: Dict[str, str] = {}
    inclusion_count: int = 0
    inclusion_fraction: float = 0.0
    is_constitutive: bool = False
    alt_five_prime: bool = False
    alt_three_prime: bool = False


class ExonAggregateStats(BaseModel):
    total_unique_boundaries: int = 0
    total_unique_exon_states: int = 0
    constitutive_exon_states: int = 0
    alternative_exon_states: int = 0
    coding_exon_states: int = 0
    partial_exon_states: int = 0
    non_coding_exon_states: int = 0
    microexon_count: int = 0
    mean_exon_length: float = 0.0
    median_exon_length: float = 0.0


class FeatureExplorerExonsSummaryResponse(BaseModel):
    gene: ExonSummaryGene
    transcripts: List[ExonSummaryTranscript]
    exons: List[ExonStateRecord]
    stats: ExonAggregateStats


class FeatureExplorerExonsDetailRequest(BaseModel):
    genome: str = "reference"
    gene_id: str
    exon_state_key: str
    transcript_ids: Optional[List[str]] = None
    flank_bp: int = 20


class ExonDetailSelected(BaseModel):
    exon_state_key: str
    exon_label: str
    boundary_key: str
    chrom: str
    start: int
    end: int
    strand: str
    length: int
    state_class: str
    coding_start: Optional[int] = None
    coding_end: Optional[int] = None
    coding_segments: List[Tuple[int, int]] = []


class ExonDetailSequence(BaseModel):
    flank_bp: int
    window_start: int
    window_end: int
    sequence: str
    exon_start_index: int
    exon_end_index: int
    feature_transcript_id: Optional[str] = None
    features: List[sequence_windows.FeatureSlice] = []


class ExonDetailJunctions(BaseModel):
    donor_motif: str = ""
    donor_total: int = 0
    donor_canonical_count: int = 0
    donor_is_canonical: bool = False
    acceptor_motif: str = ""
    acceptor_total: int = 0
    acceptor_canonical_count: int = 0
    acceptor_is_canonical: bool = False
    start_codon_inclusion_count: int = 0
    stop_codon_inclusion_count: int = 0


class ExonTranscriptInstance(BaseModel):
    transcript_id: str
    exon_rank: int
    total_exons: int
    state_class: str
    transcript_coord_start: int
    transcript_coord_end: int
    exon_sequence: str = ""
    transcript_sequence: str = ""
    cds_sequence: str = ""
    cds_overlap_length: int = 0
    cds_coord_start: Optional[int] = None
    cds_coord_end: Optional[int] = None
    cds_phase_5p: Optional[int] = None
    cds_phase_3p: Optional[int] = None
    protein_aa_start: Optional[int] = None
    protein_aa_end: Optional[int] = None
    donor_motif: str = ""
    acceptor_motif: str = ""
    includes_start_codon: bool = False
    includes_stop_codon: bool = False


class FeatureExplorerExonsDetailResponse(BaseModel):
    selected_exon: ExonDetailSelected
    sequence: ExonDetailSequence
    junctions: ExonDetailJunctions
    instances: List[ExonTranscriptInstance]


class FeatureExplorerProteinRowRequest(BaseModel):
    transcript_id: str
    window_start: int   # 1-based amino-acid position
    window_end: int     # 1-based amino-acid position


class FeatureExplorerProteinsRequest(BaseModel):
    genome: str = "reference"
    rows: List[FeatureExplorerProteinRowRequest]


class CdsSegmentInfo(BaseModel):
    """One contiguous coding-exon segment in 5'→3' CDS coordinate order."""
    coord_start: int    # 1-based CDS nucleotide position (start of segment)
    coord_end: int      # 1-based CDS nucleotide position (end of segment)
    genomic_start: int  # always ≤ genomic_end regardless of strand
    genomic_end: int
    phase: Optional[int] = None  # GFF phase (0/1/2) where available


class FeatureExplorerProteinRowResponse(BaseModel):
    transcript_id: str
    protein_id: str = ""
    status: str              # ok | no_cds | not_found | error
    message: Optional[str] = None
    coord_min: int = 1
    coord_max: int = 1       # = protein length in amino acids
    window_start: int = 1
    window_end: int = 1
    sequence: str = ""       # amino-acid sequence for the requested window
    cds_segments: List[CdsSegmentInfo] = []  # used by the client for alignment
    strand: str = "+"
    translation_table: int = 1        # NCBI genetic code used (2 = vertebrate mito, …)
    five_prime_partial: bool = False  # CDS starts mid-codon; sequence begins with X
    three_prime_partial: bool = False # trailing incomplete codon was dropped


class FeatureExplorerProteinsResponse(BaseModel):
    rows: List[FeatureExplorerProteinRowResponse]


# ── InterPro domain annotation models ──────────────────────────────────────────

class ProteinDomainEntry(BaseModel):
    accession: str = ""        # e.g. PF00069
    name: str = ""             # e.g. Protein kinase domain
    database: str = ""         # e.g. Pfam, SMART, CDD
    start: int = 0             # 1-based protein residue start
    end: int = 0               # 1-based protein residue end
    description: str = ""


class ProteinDomainRow(BaseModel):
    protein_id: str
    uniprot_id: str = ""
    status: str = "ok"         # ok | not_found | error
    message: str = ""
    domains: List[ProteinDomainEntry] = []


class ProteinDomainsRequest(BaseModel):
    protein_ids: List[str]
    genome: str = "reference"


class ProteinDomainsResponse(BaseModel):
    rows: List[ProteinDomainRow]


def _feature_explorer_interval_length(start: int, end: int) -> int:
    s = int(start)
    e = int(end)
    if e < s:
        s, e = e, s
    return max(0, (e - s) + 1)


def _feature_explorer_merge_intervals(intervals: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    if not intervals:
        return []
    ordered = sorted(
        [
            (min(int(start), int(end)), max(int(start), int(end)))
            for start, end in intervals
            if int(start) > 0 and int(end) > 0
        ],
        key=lambda x: (x[0], x[1]),
    )
    if not ordered:
        return []
    merged: List[Tuple[int, int]] = [ordered[0]]
    for start, end in ordered[1:]:
        prev_start, prev_end = merged[-1]
        if start <= (prev_end + 1):
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _feature_explorer_classify_exon_state(
    exon_start: int,
    exon_end: int,
    cds_list: List[Dict[str, Any]],
) -> Dict[str, Any]:
    ex_start = min(int(exon_start), int(exon_end))
    ex_end = max(int(exon_start), int(exon_end))
    overlaps: List[Tuple[int, int]] = []
    for cds in cds_list:
        cds_start = min(int(cds.get("start", 0) or 0), int(cds.get("end", 0) or 0))
        cds_end = max(int(cds.get("start", 0) or 0), int(cds.get("end", 0) or 0))
        if cds_start <= 0 or cds_end <= 0:
            continue
        ov_start = max(ex_start, cds_start)
        ov_end = min(ex_end, cds_end)
        if ov_end >= ov_start:
            overlaps.append((ov_start, ov_end))
    merged = _feature_explorer_merge_intervals(overlaps)
    if not merged:
        return {
            "state_class": "non_coding",
            "coding_start": None,
            "coding_end": None,
            "coding_segments": [],
        }

    exon_len = _feature_explorer_interval_length(ex_start, ex_end)
    coding_len = sum(_feature_explorer_interval_length(start, end) for start, end in merged)
    if len(merged) == 1 and coding_len >= exon_len and merged[0][0] <= ex_start and merged[0][1] >= ex_end:
        return {
            "state_class": "coding",
            "coding_start": ex_start,
            "coding_end": ex_end,
            "coding_segments": [(ex_start, ex_end)],
        }

    return {
        "state_class": "partial_coding",
        "coding_start": min(seg[0] for seg in merged),
        "coding_end": max(seg[1] for seg in merged),
        "coding_segments": merged,
    }


def _feature_explorer_oriented_boundaries(start: int, end: int, strand: str) -> Tuple[int, int]:
    s = min(int(start), int(end))
    e = max(int(start), int(end))
    if strand == "-":
        return e, s
    return s, e


def _feature_explorer_boundary_key(chrom: str, start: int, end: int, strand: str) -> str:
    s = min(int(start), int(end))
    e = max(int(start), int(end))
    return f"{chrom}:{s}:{e}:{strand}"


def _feature_explorer_partial_signature(coding_segments: List[Tuple[int, int]]) -> str:
    if not coding_segments:
        return ""
    ordered = sorted(
        [(min(int(a), int(b)), max(int(a), int(b))) for a, b in coding_segments],
        key=lambda x: (x[0], x[1]),
    )
    return ",".join(f"{start}-{end}" for start, end in ordered)


def _feature_explorer_exon_state_key(
    chrom: str,
    start: int,
    end: int,
    strand: str,
    state_class: str,
    coding_segments: List[Tuple[int, int]],
) -> str:
    boundary = _feature_explorer_boundary_key(chrom, start, end, strand)
    signature = _feature_explorer_partial_signature(coding_segments) if state_class == "partial_coding" else ""
    return f"{boundary}|{state_class}|{signature}"


def _feature_explorer_state_sort_rank(state_class: str) -> int:
    key = str(state_class or "").strip().lower()
    if key == "coding":
        return 0
    if key == "partial_coding":
        return 1
    return 2


def _feature_explorer_median(values: List[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(v) for v in values)
    n = len(ordered)
    mid = n // 2
    if n % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _feature_explorer_load_gene_and_transcripts(
    db_path: str,
    gene_id: str,
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    gene_id_value = str(gene_id or "").strip()
    if not gene_id_value:
        return None, []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    def _run_gene_query(sql: str, params: tuple) -> Optional[Dict[str, Any]]:
        for variant in [sql,
                        sql.replace(", version", ""),
                        sql.replace(", version", "").replace(", description", "")]:
            try:
                c.execute(variant, params)
                row = c.fetchone()
                if row is None:
                    return None
                data = dict(row)
                data.setdefault("description", None)
                data.setdefault("version", "")
                return data
            except sqlite3.OperationalError:
                continue
        return None

    gene_row = _run_gene_query(
        "SELECT id, name, description, version, chrom, start, end, strand, biotype FROM genes WHERE id = ? LIMIT 1",
        (gene_id_value,),
    )
    if not gene_row:
        conn.close()
        return None, []

    c.execute(
        """
        SELECT id, chrom, start, end, strand, is_canonical, data
        FROM transcripts
        WHERE parent_gene_id = ?
        ORDER BY is_canonical DESC, start ASC, id ASC
        """,
        (gene_id_value,),
    )
    tx_rows = c.fetchall()
    conn.close()

    transcripts: List[Dict[str, Any]] = []
    for row in tx_rows:
        raw_data = row["data"]
        try:
            tx_data = json.loads(raw_data) if raw_data else {}
        except Exception:
            tx_data = {}
        tx_data = tx_data if isinstance(tx_data, dict) else {}
        strand = str(row["strand"] or "+").strip() or "+"
        transcripts.append({
            "id": str(row["id"] or ""),
            "chrom": str(row["chrom"] or ""),
            "start": int(row["start"] or 0),
            "end": int(row["end"] or 0),
            "strand": strand,
            "is_canonical": bool(row["is_canonical"]),
            "biotype": str(tx_data.get("biotype", "") or ""),
            "version": str(tx_data.get("version", "") or ""),
            "exons": sequence_windows._normalize_interval_list(tx_data.get("exons", []), "exon", strand),
            "cds_list": sequence_windows._normalize_interval_list(tx_data.get("cds_list", []), "cds", strand),
            "utrs": sequence_windows._normalize_interval_list(tx_data.get("utrs", []), "utr", strand),
        })

    gene = {
        "gene_id": str(gene_row.get("id") or ""),
        "symbol": str(gene_row.get("name") or ""),
        "description": genome_context._resolve_gene_description_for_db(db_path, gene_row.get("id"), gene_row.get("description")),
        "chrom": str(gene_row.get("chrom") or ""),
        "start": int(gene_row.get("start") or 0),
        "end": int(gene_row.get("end") or 0),
        "strand": str(gene_row.get("strand") or "+"),
        "biotype": str(gene_row.get("biotype") or ""),
        "version": str(gene_row.get("version") or ""),
    }
    return gene, transcripts


def _feature_explorer_order_transcripts(
    transcripts: List[Dict[str, Any]],
    requested_ids: Optional[List[str]],
    include_inactive: bool,
) -> Tuple[List[Dict[str, Any]], Set[str]]:
    tx_by_id = {str(tx.get("id") or ""): tx for tx in transcripts if str(tx.get("id") or "")}
    default_ids = sorted(
        tx_by_id.keys(),
        key=lambda tx_id: (
            -int(bool(tx_by_id[tx_id].get("is_canonical"))),
            int(tx_by_id[tx_id].get("start") or 0),
            tx_id,
        ),
    )

    requested: List[str] = []
    for raw in (requested_ids or []):
        tid = str(raw or "").strip()
        if not tid or tid not in tx_by_id or tid in requested:
            continue
        requested.append(tid)

    if requested:
        if include_inactive:
            ordered_ids = requested + [tid for tid in default_ids if tid not in set(requested)]
        else:
            ordered_ids = list(requested)
        active_set: Set[str] = set(requested)
    else:
        ordered_ids = list(default_ids)
        active_set = set(default_ids)

    ordered_transcripts: List[Dict[str, Any]] = []
    for tid in ordered_ids:
        tx = dict(tx_by_id[tid])
        tx["is_active"] = tid in active_set
        ordered_transcripts.append(tx)
    return ordered_transcripts, active_set


def _feature_explorer_cds_overlap_span(
    cds_segments: List[Dict[str, int]],
    strand: str,
    exon_start: int,
    exon_end: int,
) -> Dict[str, Any]:
    ex_lo = min(int(exon_start), int(exon_end))
    ex_hi = max(int(exon_start), int(exon_end))
    coord_ranges: List[Tuple[int, int]] = []
    overlap_intervals: List[Tuple[int, int]] = []
    for seg in cds_segments:
        seg_lo = min(int(seg.get("genomic_start", 0) or 0), int(seg.get("genomic_end", 0) or 0))
        seg_hi = max(int(seg.get("genomic_start", 0) or 0), int(seg.get("genomic_end", 0) or 0))
        if seg_lo <= 0 or seg_hi <= 0:
            continue
        ov_start = max(seg_lo, ex_lo)
        ov_end = min(seg_hi, ex_hi)
        if ov_end < ov_start:
            continue
        overlap_intervals.append((ov_start, ov_end))
        c_start = int(seg.get("coord_start", 1) or 1)
        if strand == "+":
            proj_start = c_start + (ov_start - seg_lo)
            proj_end = c_start + (ov_end - seg_lo)
        else:
            proj_start = c_start + (seg_hi - ov_end)
            proj_end = c_start + (seg_hi - ov_start)
        coord_ranges.append((min(proj_start, proj_end), max(proj_start, proj_end)))

    if not coord_ranges:
        return {
            "cds_overlap_length": 0,
            "cds_coord_start": None,
            "cds_coord_end": None,
            "overlap_intervals": [],
        }

    return {
        "cds_overlap_length": int(sum(_feature_explorer_interval_length(start, end) for start, end in overlap_intervals)),
        "cds_coord_start": int(min(start for start, _ in coord_ranges)),
        "cds_coord_end": int(max(end for _, end in coord_ranges)),
        "overlap_intervals": overlap_intervals,
    }


def _feature_explorer_start_stop_intervals(cds_list: List[Dict[str, Any]], strand: str) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]]]:
    ordered_cds = sequence_windows._ordered_five_to_three(cds_list, strand)
    coords: List[int] = []
    for seg in ordered_cds:
        coords.extend(sequence_windows._oriented_coords_for_interval(int(seg["start"]), int(seg["end"]), strand))
    if len(coords) < 3:
        return [], []
    return sequence_windows._group_coords_to_intervals(coords[:3]), sequence_windows._group_coords_to_intervals(coords[-3:])


def _feature_explorer_collect_exon_dataset(
    genome: str,
    gene_id: str,
    transcript_ids: Optional[List[str]] = None,
    include_inactive: bool = False,
    include_sequence_fields: bool = False,
) -> Dict[str, Any]:
    db_path = genome_context._get_browse_db(genome)
    gene, transcripts = _feature_explorer_load_gene_and_transcripts(db_path, gene_id)
    if not gene:
        raise HTTPException(status_code=404, detail=f"Gene '{gene_id}' not found in {genome} genome.")

    ordered_transcripts, active_set = _feature_explorer_order_transcripts(transcripts, transcript_ids, include_inactive)
    total_transcripts = len(ordered_transcripts)
    fasta = genome_context._get_browse_fasta(genome) if include_sequence_fields else None

    records_by_key: Dict[str, Dict[str, Any]] = {}
    instances_by_key: Dict[str, List[Dict[str, Any]]] = {}
    seen_boundaries: Set[str] = set()
    five_to_three: Dict[int, Set[int]] = {}
    three_to_five: Dict[int, Set[int]] = {}

    for tx in ordered_transcripts:
        tx_id = str(tx.get("id") or "")
        tx_strand = str(tx.get("strand") or gene.get("strand") or "+")
        tx_exons = sequence_windows._ordered_five_to_three(list(tx.get("exons") or []), tx_strand)
        tx_cds_list = list(tx.get("cds_list") or [])
        tx_cds_min = min([int(c.get("start", 0) or 0) for c in tx_cds_list] + [int(c.get("end", 0) or 0) for c in tx_cds_list] + [0])
        tx_cds_max = max([int(c.get("start", 0) or 0) for c in tx_cds_list] + [int(c.get("end", 0) or 0) for c in tx_cds_list] + [0])
        _, _, cds_segments, cds_status = sequence_windows._build_mode_segments(
            tx_start=tx_cds_min if tx_cds_min > 0 else int(tx.get("start", 0) or 0),
            tx_end=tx_cds_max if tx_cds_max > 0 else int(tx.get("end", 0) or 0),
            strand=tx_strand,
            exons=[],
            cds_list=tx_cds_list,
            sequence_type="cds",
        )
        if cds_status != "ok":
            cds_segments = []

        start_codon_intervals, stop_codon_intervals = _feature_explorer_start_stop_intervals(tx_cds_list, tx_strand)
        transcript_cursor = 1
        exon_total = len(tx_exons)

        for exon_index, exon in enumerate(tx_exons):
            ex_start = min(int(exon.get("start", 0) or 0), int(exon.get("end", 0) or 0))
            ex_end = max(int(exon.get("start", 0) or 0), int(exon.get("end", 0) or 0))
            if ex_start <= 0 or ex_end <= 0 or ex_end < ex_start:
                continue
            exon_len = _feature_explorer_interval_length(ex_start, ex_end)
            tx_coord_start = transcript_cursor
            tx_coord_end = transcript_cursor + exon_len - 1
            transcript_cursor = tx_coord_end + 1

            state = _feature_explorer_classify_exon_state(ex_start, ex_end, tx_cds_list)
            state_class = str(state.get("state_class") or "non_coding")
            coding_segments = list(state.get("coding_segments") or [])
            coding_start = state.get("coding_start")
            coding_end = state.get("coding_end")

            chrom = str(tx.get("chrom") or gene.get("chrom") or "")
            strand = tx_strand
            five_prime, three_prime = _feature_explorer_oriented_boundaries(ex_start, ex_end, strand)
            boundary_key = _feature_explorer_boundary_key(chrom, ex_start, ex_end, strand)
            exon_state_key = _feature_explorer_exon_state_key(chrom, ex_start, ex_end, strand, state_class, coding_segments)

            if boundary_key not in seen_boundaries:
                seen_boundaries.add(boundary_key)
                five_to_three.setdefault(int(five_prime), set()).add(int(three_prime))
                three_to_five.setdefault(int(three_prime), set()).add(int(five_prime))

            record = records_by_key.get(exon_state_key)
            if not record:
                record = {
                    "exon_state_key": exon_state_key,
                    "exon_label": "",
                    "boundary_key": boundary_key,
                    "chrom": chrom,
                    "start": ex_start,
                    "end": ex_end,
                    "strand": strand,
                    "length": exon_len,
                    "state_class": state_class,
                    "coding_start": int(coding_start) if coding_start is not None else None,
                    "coding_end": int(coding_end) if coding_end is not None else None,
                    "coding_segments": [(int(a), int(b)) for a, b in coding_segments],
                    "transcript_ids_set": set(),
                    "transcript_states": {},
                    "inclusion_count": 0,
                    "inclusion_fraction": 0.0,
                    "is_constitutive": False,
                    "alt_five_prime": False,
                    "alt_three_prime": False,
                    "_five_prime": int(five_prime),
                    "_three_prime": int(three_prime),
                }
                records_by_key[exon_state_key] = record

            record["transcript_ids_set"].add(tx_id)
            record["transcript_states"][tx_id] = state_class

            cds_info = _feature_explorer_cds_overlap_span(cds_segments, strand, ex_start, ex_end)
            cds_coord_start = cds_info.get("cds_coord_start")
            cds_coord_end = cds_info.get("cds_coord_end")
            cds_overlap_length = int(cds_info.get("cds_overlap_length") or 0)
            cds_phase_5p = int((cds_coord_start - 1) % 3) if cds_coord_start is not None else None
            cds_phase_3p = int((cds_coord_end - 1) % 3) if cds_coord_end is not None else None
            aa_start = int(((cds_coord_start - 1) // 3) + 1) if cds_coord_start is not None else None
            aa_end = int(((cds_coord_end - 1) // 3) + 1) if cds_coord_end is not None else None

            includes_start = any(max(ex_start, s) <= min(ex_end, e) for s, e in start_codon_intervals)
            includes_stop = any(max(ex_start, s) <= min(ex_end, e) for s, e in stop_codon_intervals)

            donor_motif = ""
            acceptor_motif = ""
            if exon_index < (exon_total - 1):
                if strand == "+":
                    donor_motif = sequence_windows._fetch_oriented_piece(fasta, chrom, ex_end + 1, ex_end + 2, strand) if fasta else ""
                else:
                    donor_motif = sequence_windows._fetch_oriented_piece(fasta, chrom, ex_start - 2, ex_start - 1, strand) if fasta else ""
            if exon_index > 0:
                if strand == "+":
                    acceptor_motif = sequence_windows._fetch_oriented_piece(fasta, chrom, ex_start - 2, ex_start - 1, strand) if fasta else ""
                else:
                    acceptor_motif = sequence_windows._fetch_oriented_piece(fasta, chrom, ex_end + 1, ex_end + 2, strand) if fasta else ""

            exon_sequence = sequence_windows._fetch_oriented_piece(fasta, chrom, ex_start, ex_end, strand) if fasta else ""
            cds_sequence = ""
            if fasta and cds_overlap_length > 0:
                pieces: List[str] = []
                for ov_start, ov_end in cds_info.get("overlap_intervals") or []:
                    piece = sequence_windows._fetch_oriented_piece(fasta, chrom, int(ov_start), int(ov_end), strand)
                    if piece:
                        pieces.append(piece)
                cds_sequence = "".join(pieces)

            instance = {
                "transcript_id": tx_id,
                "exon_rank": exon_index + 1,
                "total_exons": exon_total,
                "state_class": state_class,
                "transcript_coord_start": int(tx_coord_start),
                "transcript_coord_end": int(tx_coord_end),
                "exon_sequence": exon_sequence,
                "transcript_sequence": exon_sequence,
                "cds_sequence": cds_sequence,
                "cds_overlap_length": cds_overlap_length,
                "cds_coord_start": int(cds_coord_start) if cds_coord_start is not None else None,
                "cds_coord_end": int(cds_coord_end) if cds_coord_end is not None else None,
                "cds_phase_5p": cds_phase_5p,
                "cds_phase_3p": cds_phase_3p,
                "protein_aa_start": aa_start,
                "protein_aa_end": aa_end,
                "donor_motif": donor_motif,
                "acceptor_motif": acceptor_motif,
                "includes_start_codon": bool(includes_start),
                "includes_stop_codon": bool(includes_stop),
            }
            instances_by_key.setdefault(exon_state_key, []).append(instance)

    ordered_ids = [str(tx.get("id") or "") for tx in ordered_transcripts]
    for record in records_by_key.values():
        transcript_ids_for_record = [tid for tid in ordered_ids if tid in record["transcript_ids_set"]]
        inclusion_count = len(transcript_ids_for_record)
        inclusion_fraction = (inclusion_count / total_transcripts) if total_transcripts > 0 else 0.0
        record["transcript_ids"] = transcript_ids_for_record
        record["inclusion_count"] = inclusion_count
        record["inclusion_fraction"] = float(inclusion_fraction)
        record["is_constitutive"] = bool(total_transcripts > 0 and inclusion_count == total_transcripts)
        record["alt_five_prime"] = len(three_to_five.get(int(record["_three_prime"]), set())) > 1
        record["alt_three_prime"] = len(five_to_three.get(int(record["_five_prime"]), set())) > 1

    gene_strand = str(gene.get("strand") or "+")
    records_sorted = sorted(
        records_by_key.values(),
        key=lambda rec: (
            -int(rec["_five_prime"]) if gene_strand == "-" else int(rec["_five_prime"]),
            -int(rec["_three_prime"]) if gene_strand == "-" else int(rec["_three_prime"]),
            _feature_explorer_state_sort_rank(rec.get("state_class", "")),
            _feature_explorer_partial_signature(rec.get("coding_segments") or []),
        ),
    )

    boundary_order: List[str] = []
    for rec in records_sorted:
        boundary = str(rec.get("boundary_key") or "")
        if boundary and boundary not in boundary_order:
            boundary_order.append(boundary)
    boundary_rank = {boundary: idx + 1 for idx, boundary in enumerate(boundary_order)}

    for boundary in boundary_order:
        same_boundary = [rec for rec in records_sorted if rec.get("boundary_key") == boundary]
        same_boundary.sort(
            key=lambda rec: (
                _feature_explorer_state_sort_rank(rec.get("state_class", "")),
                _feature_explorer_partial_signature(rec.get("coding_segments") or []),
            )
        )
        base_rank = boundary_rank.get(boundary, 0)
        for idx, rec in enumerate(same_boundary):
            if len(same_boundary) == 1:
                suffix = ""
            elif idx < 26:
                suffix = chr(ord("a") + idx)
            else:
                suffix = str(idx + 1)
            rec["exon_label"] = f"E{base_rank}{suffix}"

    exons_out: List[ExonStateRecord] = []
    for rec in records_sorted:
        exons_out.append(ExonStateRecord(
            exon_state_key=rec["exon_state_key"],
            exon_label=rec["exon_label"],
            boundary_key=rec["boundary_key"],
            chrom=rec["chrom"],
            start=int(rec["start"]),
            end=int(rec["end"]),
            strand=rec["strand"],
            length=int(rec["length"]),
            state_class=rec["state_class"],
            coding_start=rec["coding_start"],
            coding_end=rec["coding_end"],
            coding_segments=[(int(a), int(b)) for a, b in (rec.get("coding_segments") or [])],
            transcript_ids=list(rec.get("transcript_ids") or []),
            transcript_states=dict(rec.get("transcript_states") or {}),
            inclusion_count=int(rec.get("inclusion_count") or 0),
            inclusion_fraction=float(rec.get("inclusion_fraction") or 0.0),
            is_constitutive=bool(rec.get("is_constitutive")),
            alt_five_prime=bool(rec.get("alt_five_prime")),
            alt_three_prime=bool(rec.get("alt_three_prime")),
        ))

    lengths = [float(exon.length) for exon in exons_out]
    coding_count = sum(1 for exon in exons_out if exon.state_class == "coding")
    partial_count = sum(1 for exon in exons_out if exon.state_class == "partial_coding")
    non_coding_count = sum(1 for exon in exons_out if exon.state_class == "non_coding")
    constitutive_count = sum(1 for exon in exons_out if exon.is_constitutive)
    microexon_count = sum(1 for exon in exons_out if exon.length < 27)
    stats = ExonAggregateStats(
        total_unique_boundaries=len(boundary_order),
        total_unique_exon_states=len(exons_out),
        constitutive_exon_states=constitutive_count,
        alternative_exon_states=max(0, len(exons_out) - constitutive_count),
        coding_exon_states=coding_count,
        partial_exon_states=partial_count,
        non_coding_exon_states=non_coding_count,
        microexon_count=microexon_count,
        mean_exon_length=round((sum(lengths) / len(lengths)) if lengths else 0.0, 2),
        median_exon_length=round(_feature_explorer_median(lengths), 2),
    )

    tx_out = [
        ExonSummaryTranscript(
            transcript_id=str(tx.get("id") or ""),
            biotype=str(tx.get("biotype") or ""),
            is_canonical=bool(tx.get("is_canonical")),
            is_active=bool(str(tx.get("id") or "") in active_set),
        )
        for tx in ordered_transcripts
    ]

    return {
        "gene": ExonSummaryGene(
            gene_id=str(gene.get("gene_id") or ""),
            symbol=str(gene.get("symbol") or ""),
            chrom=str(gene.get("chrom") or ""),
            start=int(gene.get("start") or 0),
            end=int(gene.get("end") or 0),
            strand=str(gene.get("strand") or "+"),
            biotype=str(gene.get("biotype") or ""),
        ),
        "transcripts": tx_out,
        "exons": exons_out,
        "stats": stats,
        "instances_by_key": instances_by_key,
        "_ordered_transcripts": ordered_transcripts,
    }


@router.post("/api/feature_explorer/exons/summary", response_model=FeatureExplorerExonsSummaryResponse)
async def feature_explorer_exons_summary(payload: FeatureExplorerExonsSummaryRequest):
    gene_id = str(payload.gene_id or "").strip()
    if not gene_id:
        raise HTTPException(status_code=400, detail="gene_id is required")

    genome = str(payload.genome or "reference").strip() or "reference"

    def _query():
        dataset = _feature_explorer_collect_exon_dataset(
            genome=genome,
            gene_id=gene_id,
            transcript_ids=payload.transcript_ids,
            include_inactive=bool(payload.include_inactive),
            include_sequence_fields=False,
        )
        return FeatureExplorerExonsSummaryResponse(
            gene=dataset["gene"],
            transcripts=dataset["transcripts"],
            exons=dataset["exons"],
            stats=dataset["stats"],
        )

    return await run_in_threadpool(_query)


@router.post("/api/feature_explorer/exons/detail", response_model=FeatureExplorerExonsDetailResponse)
async def feature_explorer_exons_detail(payload: FeatureExplorerExonsDetailRequest):
    gene_id = str(payload.gene_id or "").strip()
    exon_state_key = str(payload.exon_state_key or "").strip()
    if not gene_id:
        raise HTTPException(status_code=400, detail="gene_id is required")
    if not exon_state_key:
        raise HTTPException(status_code=400, detail="exon_state_key is required")

    genome = str(payload.genome or "reference").strip() or "reference"
    flank_bp = max(0, min(5000, int(payload.flank_bp or 20)))

    def _query():
        dataset = _feature_explorer_collect_exon_dataset(
            genome=genome,
            gene_id=gene_id,
            transcript_ids=payload.transcript_ids,
            include_inactive=True,
            include_sequence_fields=True,
        )
        exons: List[ExonStateRecord] = dataset.get("exons") or []
        selected = next((exon for exon in exons if exon.exon_state_key == exon_state_key), None)
        if not selected:
            raise HTTPException(status_code=404, detail=f"Exon state '{exon_state_key}' not found for gene '{gene_id}'.")

        chrom = str(selected.chrom or "")
        strand = str(selected.strand or "+")
        exon_start = int(selected.start)
        exon_end = int(selected.end)
        fasta = genome_context._get_browse_fasta(genome)
        try:
            chrom_len = int(fasta.get_reference_length(chrom))
        except Exception:
            chrom_len = 0

        if chrom_len > 0:
            window_start = max(1, exon_start - flank_bp)
            window_end = min(chrom_len, exon_end + flank_bp)
        else:
            window_start = max(1, exon_start - flank_bp)
            window_end = max(window_start, exon_end + flank_bp)

        sequence = sequence_windows._fetch_oriented_piece(fasta, chrom, window_start, window_end, strand) if chrom else ""
        if strand == "-":
            exon_start_index = (window_end - exon_end) + 1
            exon_end_index = (window_end - exon_start) + 1
        else:
            exon_start_index = (exon_start - window_start) + 1
            exon_end_index = (exon_end - window_start) + 1
        exon_start_index = max(1, int(exon_start_index))
        exon_end_index = max(exon_start_index, int(exon_end_index))

        instances_raw: List[Dict[str, Any]] = list(dataset.get("instances_by_key", {}).get(exon_state_key) or [])
        instances_raw.sort(key=lambda x: (str(x.get("transcript_id") or ""), int(x.get("exon_rank") or 0)))
        instances = [ExonTranscriptInstance(**item) for item in instances_raw]

        ordered_transcripts_raw = list(dataset.get("_ordered_transcripts") or [])
        ordered_tx_by_id = {
            str(tx.get("id") or ""): tx
            for tx in ordered_transcripts_raw
            if str(tx.get("id") or "").strip()
        }
        selected_instance_ids = [str(item.get("transcript_id") or "").strip() for item in instances_raw if str(item.get("transcript_id") or "").strip()]
        selected_instance_id_set = set(selected_instance_ids)
        feature_transcript_id = ""
        for tx in ordered_transcripts_raw:
            tx_id = str(tx.get("id") or "").strip()
            if not tx_id or tx_id not in selected_instance_id_set:
                continue
            if bool(tx.get("is_canonical")):
                feature_transcript_id = tx_id
                break
        if not feature_transcript_id and selected_instance_ids:
            feature_transcript_id = selected_instance_ids[0]

        feature_slices: List[sequence_windows.FeatureSlice] = []
        if feature_transcript_id and feature_transcript_id in ordered_tx_by_id and chrom:
            tx = ordered_tx_by_id.get(feature_transcript_id) or {}
            tx_exons = list(tx.get("exons") or [])
            tx_cds_list = list(tx.get("cds_list") or [])
            tx_utrs = list(tx.get("utrs") or [])
            tx_features = sequence_windows._build_tx_feature_intervals(
                fasta=fasta,
                chrom=chrom,
                strand=strand,
                exons=tx_exons,
                cds_list=tx_cds_list,
                utrs=tx_utrs,
            )
            feature_priority = {
                "start_codon": 1,
                "stop_codon": 2,
                "donor": 3,
                "acceptor": 4,
                "utr5": 5,
                "utr3": 6,
                "cds": 7,
                "exon": 8,
                "intron": 9,
            }
            allowed_types = {
                "start_codon", "stop_codon", "donor", "acceptor",
                "utr5", "utr3", "cds", "exon", "intron",
            }
            raw_feature_slices: List[Dict[str, int]] = []
            for feat in sorted(
                tx_features,
                key=lambda x: (feature_priority.get(str(x.get("type", "")), 99), int(x.get("start", 0)))
            ):
                ftype = str(feat.get("type", "")).strip()
                if ftype not in allowed_types:
                    continue
                g_start = int(feat.get("start", 0) or 0)
                g_end = int(feat.get("end", 0) or 0)
                if g_start <= 0 or g_end <= 0:
                    continue
                if g_end < g_start:
                    g_start, g_end = g_end, g_start
                raw_feature_slices.extend(sequence_windows._project_feature_to_window_slices(
                    ftype=ftype,
                    g_start=g_start,
                    g_end=g_end,
                    sequence_type="genomic",
                    strand=strand,
                    segments=[],
                    window_start=int(window_start),
                    window_end=int(window_end),
                ))
            feature_slices = sequence_windows._merge_feature_slices(raw_feature_slices)

        donor_motifs = [str(item.donor_motif or "").upper() for item in instances if str(item.donor_motif or "").strip()]
        acceptor_motifs = [str(item.acceptor_motif or "").upper() for item in instances if str(item.acceptor_motif or "").strip()]
        donor_canonical_count = sum(1 for motif in donor_motifs if motif == "GT")
        acceptor_canonical_count = sum(1 for motif in acceptor_motifs if motif == "AG")
        donor_mode = max(set(donor_motifs), key=donor_motifs.count) if donor_motifs else ""
        acceptor_mode = max(set(acceptor_motifs), key=acceptor_motifs.count) if acceptor_motifs else ""
        start_inclusion_count = sum(1 for item in instances if item.includes_start_codon)
        stop_inclusion_count = sum(1 for item in instances if item.includes_stop_codon)

        return FeatureExplorerExonsDetailResponse(
            selected_exon=ExonDetailSelected(
                exon_state_key=selected.exon_state_key,
                exon_label=selected.exon_label,
                boundary_key=selected.boundary_key,
                chrom=selected.chrom,
                start=selected.start,
                end=selected.end,
                strand=selected.strand,
                length=selected.length,
                state_class=selected.state_class,
                coding_start=selected.coding_start,
                coding_end=selected.coding_end,
                coding_segments=selected.coding_segments,
            ),
            sequence=ExonDetailSequence(
                flank_bp=flank_bp,
                window_start=int(window_start),
                window_end=int(window_end),
                sequence=sequence,
                exon_start_index=int(exon_start_index),
                exon_end_index=int(exon_end_index),
                feature_transcript_id=feature_transcript_id or None,
                features=feature_slices,
            ),
            junctions=ExonDetailJunctions(
                donor_motif=donor_mode,
                donor_total=len(donor_motifs),
                donor_canonical_count=donor_canonical_count,
                donor_is_canonical=bool(len(donor_motifs) > 0 and donor_canonical_count == len(donor_motifs)),
                acceptor_motif=acceptor_mode,
                acceptor_total=len(acceptor_motifs),
                acceptor_canonical_count=acceptor_canonical_count,
                acceptor_is_canonical=bool(len(acceptor_motifs) > 0 and acceptor_canonical_count == len(acceptor_motifs)),
                start_codon_inclusion_count=start_inclusion_count,
                stop_codon_inclusion_count=stop_inclusion_count,
            ),
            instances=instances,
        )

    return await run_in_threadpool(_query)


@router.post("/api/feature_explorer/sequences", response_model=FeatureExplorerSequencesResponse)
async def feature_explorer_sequences(payload: FeatureExplorerSequencesRequest):
    sequence_type = str(payload.sequence_type or "").strip().lower()
    if sequence_type not in {"genomic", "transcript", "cds"}:
        raise HTTPException(status_code=400, detail="sequence_type must be one of: genomic, transcript, cds")
    if not payload.rows:
        raise HTTPException(status_code=400, detail="rows must not be empty")
    if len(payload.rows) > 50:
        raise HTTPException(status_code=400, detail="rows limit exceeded (max 50)")

    genome = str(payload.genome or "reference").strip() or "reference"
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _query():
        fasta = genome_context._get_browse_fasta(genome)
        tx_ids = []
        for row in payload.rows:
            tx_id = str(row.transcript_id or "").strip()
            if tx_id and tx_id not in tx_ids:
                tx_ids.append(tx_id)

        tx_map: Dict[str, Dict[str, Any]] = {}
        if tx_ids:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            placeholders = ",".join("?" for _ in tx_ids)
            c.execute(
                f"SELECT id, chrom, start, end, strand, data FROM transcripts WHERE id IN ({placeholders})",
                tx_ids
            )
            for row in c.fetchall():
                tx_id = str(row["id"])
                raw_data = row["data"]
                try:
                    tx_data = json.loads(raw_data) if raw_data else {}
                except Exception:
                    tx_data = {}
                tx_map[tx_id] = {
                    "id": tx_id,
                    "chrom": str(row["chrom"] or ""),
                    "start": int(row["start"] or 0),
                    "end": int(row["end"] or 0),
                    "strand": str(row["strand"] or "+"),
                    "data": tx_data if isinstance(tx_data, dict) else {},
                }
            conn.close()

        feature_priority = {
            "start_codon": 1,
            "stop_codon": 1,
            "donor": 1,
            "acceptor": 1,
            "utr5": 2,
            "utr3": 2,
            "cds": 2,
            "exon": 3,
            "intron": 3,
        }

        rows_out: List[FeatureExplorerSequenceRowResponse] = []
        seg_cache: Dict[Tuple[str, str], Tuple[int, int, List[Dict[str, int]], str]] = {}
        tx_feature_cache: Dict[str, List[Dict[str, Any]]] = {}

        for row_req in payload.rows:
            tx_id = str(row_req.transcript_id or "").strip()
            w_start = int(row_req.window_start or 0)
            w_end = int(row_req.window_end or 0)
            row_len = (w_end - w_start) + 1

            if row_len <= 0:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message="window_end must be >= window_start",
                    chrom="",
                    strand="+",
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="",
                    features=[],
                ))
                continue
            if row_len > 50000:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message="Requested window too large (max 50,000 bp)",
                    chrom="",
                    strand="+",
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="",
                    features=[],
                ))
                continue

            tx = tx_map.get(tx_id)
            if not tx:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="not_found",
                    message="Transcript not found in current genome index",
                    chrom="",
                    strand="+",
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue

            chrom = str(tx["chrom"] or "")
            strand = str(tx["strand"] or "+")
            t_start = int(tx["start"] or 0)
            t_end = int(tx["end"] or 0)
            tx_data = tx["data"] if isinstance(tx.get("data"), dict) else {}

            exons = sequence_windows._normalize_interval_list(tx_data.get("exons", []), "exon", strand)
            cds_list = sequence_windows._normalize_interval_list(tx_data.get("cds_list", []), "cds", strand)
            utrs = sequence_windows._normalize_interval_list(tx_data.get("utrs", []), "utr", strand)

            seg_key = (tx_id, sequence_type)
            if seg_key not in seg_cache:
                seg_cache[seg_key] = sequence_windows._build_mode_segments(
                    tx_start=t_start,
                    tx_end=t_end,
                    strand=strand,
                    exons=exons,
                    cds_list=cds_list,
                    sequence_type=sequence_type,
                )
            coord_min, coord_max, segments, seg_status = seg_cache[seg_key]

            if seg_status == "no_cds":
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="no_cds",
                    message="No CDS is defined for this transcript",
                    chrom=chrom,
                    strand=strand,
                    coord_min=1,
                    coord_max=1,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue
            if seg_status != "ok":
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message="Unable to build coordinate segments for transcript",
                    chrom=chrom,
                    strand=strand,
                    coord_min=coord_min,
                    coord_max=coord_max,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue

            try:
                if sequence_type == "genomic":
                    seq = sequence_windows._extract_genomic_window_sequence(
                        fasta=fasta,
                        chrom=chrom,
                        strand=strand,
                        tx_start=t_start,
                        tx_end=t_end,
                        window_start=w_start,
                        window_end=w_end,
                        placeholder="-",
                    )
                else:
                    seq = sequence_windows._extract_window_sequence_from_segments(
                        fasta=fasta,
                        chrom=chrom,
                        strand=strand,
                        segments=segments,
                        coord_min=coord_min,
                        coord_max=coord_max,
                        window_start=w_start,
                        window_end=w_end,
                        placeholder="-",
                    )
            except Exception as e:
                rows_out.append(FeatureExplorerSequenceRowResponse(
                    transcript_id=tx_id,
                    status="error",
                    message=f"Sequence fetch failed: {e}",
                    chrom=chrom,
                    strand=strand,
                    coord_min=coord_min,
                    coord_max=coord_max,
                    window_start=w_start,
                    window_end=w_end,
                    sequence="-" * row_len,
                    features=[],
                ))
                continue

            feature_slices: List[sequence_windows.FeatureSlice] = []
            if payload.include_features:
                if tx_id not in tx_feature_cache:
                    tx_feature_cache[tx_id] = sequence_windows._build_tx_feature_intervals(
                        fasta=fasta,
                        chrom=chrom,
                        strand=strand,
                        exons=exons,
                        cds_list=cds_list,
                        utrs=utrs,
                    )
                tx_features = tx_feature_cache[tx_id]

                if sequence_type == "genomic":
                    allowed_types = {
                        "start_codon", "stop_codon", "donor", "acceptor",
                        "utr5", "utr3", "cds", "exon", "intron"
                    }
                elif sequence_type == "transcript":
                    allowed_types = {"start_codon", "stop_codon", "utr5", "utr3", "cds", "exon"}
                else:
                    allowed_types = {"start_codon", "stop_codon", "cds"}

                raw_slices: List[Dict[str, int]] = []
                for feat in sorted(
                    tx_features,
                    key=lambda x: (feature_priority.get(str(x.get("type", "")), 99), int(x.get("start", 0)))
                ):
                    ftype = str(feat.get("type", "")).strip()
                    if ftype not in allowed_types:
                        continue
                    g_start = int(feat.get("start", 0) or 0)
                    g_end = int(feat.get("end", 0) or 0)
                    if g_start <= 0 or g_end <= 0:
                        continue
                    if g_end < g_start:
                        g_start, g_end = g_end, g_start
                    raw_slices.extend(sequence_windows._project_feature_to_window_slices(
                        ftype=ftype,
                        g_start=g_start,
                        g_end=g_end,
                        sequence_type=sequence_type,
                        strand=strand,
                        segments=segments,
                        window_start=w_start,
                        window_end=w_end,
                    ))
                feature_slices = sequence_windows._merge_feature_slices(raw_slices)

            rows_out.append(FeatureExplorerSequenceRowResponse(
                transcript_id=tx_id,
                status="ok",
                message=None,
                chrom=chrom,
                strand=strand,
                coord_min=coord_min,
                coord_max=coord_max,
                window_start=w_start,
                window_end=w_end,
                sequence=seq,
                features=feature_slices,
            ))

        return FeatureExplorerSequencesResponse(
            sequence_type=sequence_type,
            rows=rows_out,
        )

    return await run_in_threadpool(_query)


@router.post("/api/feature_explorer/proteins", response_model=FeatureExplorerProteinsResponse)
async def feature_explorer_proteins(payload: FeatureExplorerProteinsRequest):
    """Fetch amino-acid sequences for coding transcripts, windowed for panning."""
    if not payload.rows:
        raise HTTPException(status_code=400, detail="rows must not be empty")
    if len(payload.rows) > 50:
        raise HTTPException(status_code=400, detail="rows limit exceeded (max 50)")

    genome = str(payload.genome or "reference").strip() or "reference"
    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _query():
        fasta = genome_context._get_browse_fasta(genome)

        tx_ids: List[str] = []
        for row in payload.rows:
            tx_id = str(row.transcript_id or "").strip()
            if tx_id and tx_id not in tx_ids:
                tx_ids.append(tx_id)

        # Fetch transcript data from DB
        tx_map: Dict[str, Dict[str, Any]] = {}
        if tx_ids:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            c = conn.cursor()
            placeholders = ",".join("?" for _ in tx_ids)
            c.execute(
                f"SELECT id, chrom, strand, parent_gene_id, data FROM transcripts WHERE id IN ({placeholders})",
                tx_ids,
            )
            for row in c.fetchall():
                raw_data = row["data"]
                try:
                    tx_data = json.loads(raw_data) if raw_data else {}
                except Exception:
                    tx_data = {}
                tx_map[str(row["id"])] = {
                    "chrom": str(row["chrom"] or ""),
                    "strand": str(row["strand"] or "+"),
                    "parent_gene_id": str(row["parent_gene_id"] or ""),
                    "data": tx_data if isinstance(tx_data, dict) else {},
                }
            conn.close()

        # Read source GFF path to look up protein_id attributes
        source_gff = ""
        try:
            conn = sqlite3.connect(db_path)
            c = conn.cursor()
            c.execute("SELECT value FROM metadata WHERE key = 'source_gff'")
            row = c.fetchone()
            conn.close()
            source_gff = str(row[0]) if row and row[0] else ""
        except Exception:
            pass
        protein_id_map = gff_index._extract_protein_ids_from_gff(
            source_gff,
            set(tx_ids),
            {
                tx_id: str((tx_map.get(tx_id) or {}).get("parent_gene_id") or "")
                for tx_id in tx_ids
            },
        )

        # Translate CDS sequences and cache results per tx_id (avoid re-translating for multiple windows)
        protein_seq_cache: Dict[str, str] = {}
        # Codon-aligned CDS layout per tx_id, reused for the client-side alignment
        layout_cache: Dict[str, TranslationLayout] = {}
        table_cache: Dict[str, int] = {}

        rows_out: List[FeatureExplorerProteinRowResponse] = []
        for row_req in payload.rows:
            tx_id = str(row_req.transcript_id or "").strip()
            w_start = max(1, int(row_req.window_start or 1))
            w_end = max(w_start, int(row_req.window_end or w_start))

            tx = tx_map.get(tx_id)
            if not tx:
                rows_out.append(FeatureExplorerProteinRowResponse(
                    transcript_id=tx_id, protein_id="",
                    status="not_found", message="Transcript not found",
                    coord_min=1, coord_max=1,
                    window_start=w_start, window_end=w_end, sequence="",
                ))
                continue

            cds_list = tx["data"].get("cds_list", [])
            if not cds_list:
                rows_out.append(FeatureExplorerProteinRowResponse(
                    transcript_id=tx_id, protein_id="",
                    status="no_cds", message="No CDS — non-coding transcript",
                    coord_min=1, coord_max=1,
                    window_start=w_start, window_end=w_end, sequence="",
                ))
                continue

            if tx_id not in protein_seq_cache:
                # Organelle contigs use their own genetic code; when the species
                # lineage is unknown (manual genomes) fall back to detecting it.
                table, molecule, table_resolved = transcript_translation._resolve_translation_table(genome, tx["chrom"])
                aa, layout, used_table = transcript_translation._translate_transcript(
                    fasta,
                    tx["chrom"],
                    tx["strand"],
                    cds_list,
                    table=table,
                    molecule=molecule,
                    autodetect=not table_resolved,
                )
                protein_seq_cache[tx_id] = aa
                layout_cache[tx_id] = layout
                table_cache[tx_id] = used_table
            aa_seq = protein_seq_cache[tx_id]
            layout = layout_cache[tx_id]

            if not aa_seq:
                rows_out.append(FeatureExplorerProteinRowResponse(
                    transcript_id=tx_id, protein_id=protein_id_map.get(tx_id, ""),
                    status="error", message="Failed to translate CDS sequence",
                    coord_min=1, coord_max=1,
                    window_start=w_start, window_end=w_end, sequence="",
                    cds_segments=[], strand=tx["strand"],
                    translation_table=table_cache.get(tx_id, TABLE_STANDARD),
                ))
                continue

            protein_len = len(aa_seq)
            w_start = max(1, min(w_start, protein_len))
            w_end = min(w_end, protein_len)
            window_seq = aa_seq[w_start - 1:w_end]
            # Coordinates are codon-aligned: amino acid n covers CDS nucleotides
            # 3n-2..3n, including when a 5'-incomplete CDS shifts the frame.
            seg_objs = [
                CdsSegmentInfo(
                    coord_start=s.coord_start,
                    coord_end=s.coord_end,
                    genomic_start=s.genomic_start,
                    genomic_end=s.genomic_end,
                    phase=s.phase,
                )
                for s in layout.segments
            ]

            rows_out.append(FeatureExplorerProteinRowResponse(
                transcript_id=tx_id,
                protein_id=protein_id_map.get(tx_id, ""),
                status="ok",
                coord_min=1,
                coord_max=protein_len,
                window_start=w_start,
                window_end=w_end,
                sequence=window_seq,
                cds_segments=seg_objs,
                strand=tx["strand"],
                translation_table=table_cache.get(tx_id, TABLE_STANDARD),
                five_prime_partial=layout.five_prime_partial,
                three_prime_partial=layout.three_prime_partial,
            ))

        return FeatureExplorerProteinsResponse(rows=rows_out)

    return await run_in_threadpool(_query)


# ── InterPro domain annotation helpers ─────────────────────────────────────────

# In-memory cache: {protein_id -> ProteinDomainRow}
_domain_cache: Dict[str, "ProteinDomainRow"] = {}


# In-memory cache: {ensp_id -> uniprot_accession}
_uniprot_id_cache: Dict[str, str] = {}


def _lookup_uniprot_id(ensp_id: str) -> str:
    """Map an Ensembl or RefSeq protein ID to a UniProt accession."""
    protein_id = str(ensp_id or "").strip()
    if not protein_id:
        return ""
    cache_key = protein_structure.strip_id_version(protein_id).upper()
    if cache_key in _uniprot_id_cache:
        return _uniprot_id_cache[cache_key]
    try:
        accession = routes.structure._uniprot_accession_from_api(protein_id)
    except Exception as exc:
        logging.debug("UniProt lookup failed for %s: %s", protein_id, exc)
        return ""
    _uniprot_id_cache[cache_key] = accession
    return accession


def _fetch_interpro_domains(uniprot_id: str) -> List[ProteinDomainEntry]:
    """Fetch domain annotations from InterPro for a UniProt accession."""
    if not uniprot_id:
        return []
    accession = protein_structure.normalize_accession(uniprot_id)
    if not accession:
        return []
    try:
        # Routed through the annotation allowlist rather than a raw urlopen, so
        # this call is subject to the same host and redirect rules as every other
        # outbound request the backend makes.
        url = f"https://www.ebi.ac.uk/interpro/api/entry/all/protein/uniprot/{accession}?format=json"
        data = routes.structure._annotation_get_json(url) or {}

        domains: List[ProteinDomainEntry] = []
        for result in data.get("results", []):
            meta = result.get("metadata", {})
            acc = meta.get("accession", "")
            name = meta.get("name", "")
            db = meta.get("source_database", "").replace("_", " ").title()
            desc = meta.get("description", "")
            if isinstance(desc, list):
                desc = desc[0].get("text", "") if desc else ""

            # Extract protein locations
            for protein_entry in result.get("proteins", []):
                for loc_group in protein_entry.get("entry_protein_locations", []):
                    for fragment in loc_group.get("fragments", []):
                        start = int(fragment.get("start", 0))
                        end = int(fragment.get("end", 0))
                        if start > 0 and end > 0:
                            domains.append(ProteinDomainEntry(
                                accession=acc,
                                name=name,
                                database=db,
                                start=start,
                                end=end,
                                description=str(desc)[:300],
                            ))

        # Sort by start position
        domains.sort(key=lambda d: (d.start, d.end))
        return domains
    except Exception as exc:
        logging.debug("InterPro fetch failed for %s: %s", uniprot_id, exc)
        return []


@router.post("/api/feature_explorer/protein_domains", response_model=ProteinDomainsResponse)
async def feature_explorer_protein_domains(payload: ProteinDomainsRequest):
    """Fetch InterPro domain annotations for Ensembl protein IDs."""
    if not payload.protein_ids:
        raise HTTPException(status_code=400, detail="protein_ids must not be empty")
    if len(payload.protein_ids) > 20:
        raise HTTPException(status_code=400, detail="protein_ids limit exceeded (max 20)")

    def _query():
        rows_out: List[ProteinDomainRow] = []

        for pid in payload.protein_ids:
            pid = str(pid or "").strip()
            if not pid:
                continue

            # Check cache
            if pid in _domain_cache:
                rows_out.append(_domain_cache[pid])
                continue

            # Map ENSP -> UniProt
            uniprot_id = _lookup_uniprot_id(pid)
            if not uniprot_id:
                row = ProteinDomainRow(
                    protein_id=pid, uniprot_id="",
                    status="not_found",
                    message="Could not map to UniProt accession",
                )
                _domain_cache[pid] = row
                rows_out.append(row)
                continue

            # Fetch domains from InterPro
            domains = _fetch_interpro_domains(uniprot_id)
            row = ProteinDomainRow(
                protein_id=pid,
                uniprot_id=uniprot_id,
                status="ok",
                domains=domains,
            )
            _domain_cache[pid] = row
            rows_out.append(row)

        return ProteinDomainsResponse(rows=rows_out)

    return await run_in_threadpool(_query)
