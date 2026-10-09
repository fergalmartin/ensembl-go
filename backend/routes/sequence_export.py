"""Exporting sequences: FASTA records for transcripts and their features (exons, introns,
UTRs, CDS, protein) in the chosen orientations, the transcript sequences the export
dialog previews, and saving an export file to disk.
"""

import base64
import gzip
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import genome_context
import sequence_windows
import transcript_translation
from security_utils import safe_export_filename

router = APIRouter()


class ExportSequencesRequest(BaseModel):
    genome: str = "reference"
    gene_id: str = ""
    transcript_ids: List[str]
    feature_types: List[str]          # genomic | transcript | cds | exons | utr5 | utr3 | introns
    orientations: List[str] = ["fwd"] # fwd (5'→3') | rev (3'→5', reverse complement)
    output_dir: str
    output_structure: str = "per_transcript"  # single | per_transcript | per_feature
    filename: Optional[str] = None            # used when output_structure == "single"
    compress: bool = False
    header_fields: Optional[Dict[str, bool]] = None


class ExportSequencesResponse(BaseModel):
    files: List[str]
    errors: List[str]


class TranscriptSequencesRequest(BaseModel):
    genome: str = "reference"
    gene_id: str = ""
    transcript_id: str
    # Any of the export feature types; omitted means "everything available".
    feature_types: Optional[List[str]] = None
    reverse_complement: bool = False


class TranscriptSequenceRecord(BaseModel):
    feature_type: str
    header: str
    sequence: str
    length: int
    unit: str = "bp"
    # 1-based ordinal in 5'→3' order, for the types that yield one record per
    # feature (exons, introns). None for the single-record types.
    rank: Optional[int] = None


class TranscriptSequencesResponse(BaseModel):
    transcript_id: str
    # feature_type -> whether this transcript can offer it at all, so the caller
    # can show the unavailable ones greyed rather than hiding them.
    available: Dict[str, bool]
    records: List[TranscriptSequenceRecord]
    errors: List[str] = []


class SaveExportRequest(BaseModel):
    directory: str
    filename: str
    format: str = "svg"
    mime_type: str = ""
    encoding: str = "utf8"  # utf8 | base64
    data: str


class SaveExportResponse(BaseModel):
    ok: bool = True
    path: str
    filename: str


# ─────────────────────────────────────────────────────────────────────────────
# Sequence export helpers
# ─────────────────────────────────────────────────────────────────────────────

_FEATURE_SLUGS: Dict[str, str] = {
    "genomic":    "genomic",
    "transcript": "transcript",
    "cds":        "cds",
    "exons":      "exons",
    "utr5":       "5primeutr",
    "utr3":       "3primeutr",
    "introns":    "introns",
    "protein":    "protein",
    "utr":        "utr",
}


def _is_five_prime_utr(utr: Dict[str, Any]) -> bool:
    ft = str(utr.get("feature_type", "") or "").lower()
    return "five" in ft or "5_prime" in ft or "5prime" in ft


def _is_three_prime_utr(utr: Dict[str, Any]) -> bool:
    ft = str(utr.get("feature_type", "") or "").lower()
    return "three" in ft or "3_prime" in ft or "3prime" in ft


def _compute_utr_intervals(
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    strand: str,
    which: str,  # "utr5" | "utr3"
) -> List[Dict[str, Any]]:
    """Derive UTR intervals from exon / CDS overlap when explicit UTR records are absent."""
    if not exons or not cds_list:
        return []
    cds_min = min(int(c["start"]) for c in cds_list)
    cds_max = max(int(c["end"])   for c in cds_list)
    result: List[Dict[str, Any]] = []
    for exon in exons:
        e_start = int(exon["start"])
        e_end   = int(exon["end"])
        if strand == "+":
            if which == "utr5" and e_start < cds_min:
                result.append({"start": e_start, "end": min(e_end, cds_min - 1)})
            elif which == "utr3" and e_end > cds_max:
                result.append({"start": max(e_start, cds_max + 1), "end": e_end})
        else:  # minus strand: 5' UTR is genomically after CDS, 3' UTR is before
            if which == "utr5" and e_end > cds_max:
                result.append({"start": max(e_start, cds_max + 1), "end": e_end})
            elif which == "utr3" and e_start < cds_min:
                result.append({"start": e_start, "end": min(e_end, cds_min - 1)})
    return result


def _compute_introns_from_exons(exons: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return intron intervals (genomic) sorted ascending by start position."""
    if len(exons) < 2:
        return []
    sorted_exons = sorted(exons, key=lambda e: int(e["start"]))
    introns: List[Dict[str, Any]] = []
    for i in range(len(sorted_exons) - 1):
        i_start = int(sorted_exons[i]["end"]) + 1
        i_end   = int(sorted_exons[i + 1]["start"]) - 1
        if i_end >= i_start:
            introns.append({"start": i_start, "end": i_end})
    return introns


def _wrap_sequence(seq: str, width: int = 60) -> str:
    return "\n".join(seq[i:i + width] for i in range(0, max(1, len(seq)), width))


def _build_fasta_header(
    tx_id: str,
    gene_id: str,
    feature_name: str,
    chrom: str,
    g_start: int,
    g_end: int,
    strand: str,
    seq_len: int,
    header_fields: Dict[str, bool],
    biotype: str,
    canonical_info: str,
    rank: Optional[int] = None,
    length_unit: str = "bp",
) -> str:
    parts: List[str] = [f">{tx_id}"]
    if gene_id and gene_id != tx_id:
        parts.append(f"gene={gene_id}")
    parts.append(f"feature={feature_name}")
    # Rank is its own field rather than a suffix on the feature name, so the
    # feature stays greppable as "exon" and the ordinal is machine-readable.
    if rank is not None and header_fields.get("exon_number", True):
        parts.append(f"{feature_name}_rank:{rank}")
    if header_fields.get("location"):
        parts.append(f"{chrom}:{g_start}-{g_end}")
    if header_fields.get("strand"):
        parts.append(f"strand={'forward' if strand == '+' else 'reverse'}")
    if header_fields.get("length"):
        parts.append(f"len={seq_len}{length_unit}")
    if header_fields.get("biotype") and biotype:
        parts.append(f"biotype={biotype}")
    if header_fields.get("canonical_status") and canonical_info:
        parts.append(f"[{canonical_info}]")
    return " ".join(parts)


def _apply_orientations(records: List[str], orientations: List[str]) -> List[str]:
    """Expand records to include forward and/or reverse-complement orientations."""
    include_fwd = "fwd" in orientations
    include_rev = "rev" in orientations
    if not include_fwd and not include_rev:
        return records  # fallback: return as-is
    _rc_table = str.maketrans("ACGTNacgtn", "TGCANtgcan")

    def _rev_comp(seq: str) -> str:
        return seq.translate(_rc_table)[::-1]

    result: List[str] = []
    for rec in records:
        header, _, seq_block = rec.partition("\n")
        seq = seq_block.replace("\n", "")
        if include_fwd:
            result.append(rec)
        if include_rev:
            result.append(f"{header} [rc]\n{_wrap_sequence(_rev_comp(seq))}")
    return result


def _extract_feature_records(
    fasta,
    chrom: str,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    utrs: List[Dict[str, Any]],
    feature_type: str,
    tx_id: str,
    gene_id: str,
    header_fields: Dict[str, bool],
    biotype: str,
    canonical_info: str,
    tx_genomic_span: Optional[Tuple[int, int]] = None,
    genome: str = "reference",
) -> List[str]:
    """Return a list of FASTA record strings (header + wrapped sequence) for one feature type."""
    records: List[str] = []
    include_num = header_fields.get("exon_number", True)

    if feature_type == "genomic":
        if tx_genomic_span and tx_genomic_span[0] and tx_genomic_span[1]:
            g_start = min(tx_genomic_span)
            g_end   = max(tx_genomic_span)
        elif exons:
            g_start = min(int(e["start"]) for e in exons)
            g_end   = max(int(e["end"])   for e in exons)
        else:
            return []
        seq = sequence_windows._fetch_oriented_piece(fasta, chrom, g_start, g_end, strand)
        if not seq:
            return []
        hdr = _build_fasta_header(tx_id, gene_id, "genomic", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "transcript":
        if not exons:
            return []
        ordered = sequence_windows._ordered_five_to_three(exons, strand)
        seq = "".join(sequence_windows._fetch_oriented_piece(fasta, chrom, e["start"], e["end"], strand) for e in ordered)
        if not seq:
            return []
        g_start = min(int(e["start"]) for e in exons)
        g_end   = max(int(e["end"])   for e in exons)
        hdr = _build_fasta_header(tx_id, gene_id, "transcript", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "cds":
        if not cds_list:
            return []
        ordered = sequence_windows._ordered_five_to_three(cds_list, strand)
        seq = "".join(sequence_windows._fetch_oriented_piece(fasta, chrom, c["start"], c["end"], strand) for c in ordered)
        if not seq:
            return []
        g_start = min(int(c["start"]) for c in cds_list)
        g_end   = max(int(c["end"])   for c in cds_list)
        hdr = _build_fasta_header(tx_id, gene_id, "cds", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "exons":
        if not exons:
            return []
        ordered = sequence_windows._ordered_five_to_three(exons, strand)
        for i, exon in enumerate(ordered, 1):
            seq = sequence_windows._fetch_oriented_piece(fasta, chrom, exon["start"], exon["end"], strand)
            if not seq:
                continue
            hdr = _build_fasta_header(tx_id, gene_id, "exon", chrom, int(exon["start"]), int(exon["end"]), strand, len(seq), header_fields, biotype, canonical_info, rank=i if include_num else None)
            records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "utr":
        # Both ends under one heading, 5' first: a reader asking for "the UTR"
        # wants whichever this transcript has, in reading order.
        for side in ("utr5", "utr3"):
            records.extend(_extract_feature_records(
                fasta, chrom, strand, exons, cds_list, utrs,
                side, tx_id, gene_id, header_fields, biotype, canonical_info,
                tx_genomic_span=tx_genomic_span, genome=genome,
            ))

    elif feature_type in ("utr5", "utr3"):
        # Prefer explicit UTR annotations; fall back to computed intervals.
        if feature_type == "utr5":
            explicit = [u for u in utrs if _is_five_prime_utr(u)]
        else:
            explicit = [u for u in utrs if _is_three_prime_utr(u)]

        intervals = sequence_windows._ordered_five_to_three(explicit, strand) if explicit else \
                    sequence_windows._ordered_five_to_three(_compute_utr_intervals(exons, cds_list, strand, feature_type), strand)
        if not intervals:
            return []
        seq = "".join(sequence_windows._fetch_oriented_piece(fasta, chrom, u["start"], u["end"], strand) for u in intervals)
        if not seq:
            return []
        g_start = min(int(u["start"]) for u in intervals)
        g_end   = max(int(u["end"])   for u in intervals)
        label   = "5primeutr" if feature_type == "utr5" else "3primeutr"
        hdr = _build_fasta_header(tx_id, gene_id, label, chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info)
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "introns":
        if len(exons) < 2:
            return []
        raw_introns = _compute_introns_from_exons(exons)
        ordered = sequence_windows._ordered_five_to_three(raw_introns, strand)
        for i, intron in enumerate(ordered, 1):
            seq = sequence_windows._fetch_oriented_piece(fasta, chrom, intron["start"], intron["end"], strand)
            if not seq:
                continue
            hdr = _build_fasta_header(tx_id, gene_id, "intron", chrom, int(intron["start"]), int(intron["end"]), strand, len(seq), header_fields, biotype, canonical_info, rank=i if include_num else None)
            records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    elif feature_type == "protein":
        if not cds_list:
            return []
        # Same translator the Feature Explorer's protein track uses, so an
        # organelle gene is not read with the nuclear code here and the
        # mitochondrial one there.
        table, molecule, _resolved = transcript_translation._resolve_translation_table(genome or "reference", chrom)
        seq, _layout, _table = transcript_translation._translate_transcript(
            fasta, chrom, strand, cds_list, table=table, molecule=molecule,
        )
        if not seq:
            return []
        g_start = min(int(c["start"]) for c in cds_list)
        g_end   = max(int(c["end"])   for c in cds_list)
        hdr = _build_fasta_header(tx_id, gene_id, "protein", chrom, g_start, g_end, strand, len(seq), header_fields, biotype, canonical_info, length_unit="aa")
        records.append(f"{hdr}\n{_wrap_sequence(seq)}")

    return records


#: Every feature type the record extractor can produce, in the order a reader
#: would want them offered.
_ALL_FEATURE_TYPES: List[str] = [
    "genomic", "transcript", "cds", "protein", "utr", "exons", "introns",
]


#: The record extractor yields a record per feature for these; everything else
#: is a single concatenated record.
_RANKED_FEATURE_TYPES = frozenset({"exons", "introns"})


def _available_feature_types(
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    utrs: List[Dict[str, Any]],
    strand: str,
    has_span: bool,
) -> Dict[str, bool]:
    """Which feature types this transcript can offer, from annotation alone.

    Deliberately free of sequence reads: the caller needs this to grey out the
    options it cannot show, and waiting on the FASTA for that would be absurd.
    """
    def _utr_available(kind: str) -> bool:
        predicate = _is_five_prime_utr if kind == "utr5" else _is_three_prime_utr
        if any(predicate(u) for u in utrs):
            return True
        # No explicit annotation: the same fallback the extractor itself uses.
        return bool(_compute_utr_intervals(exons, cds_list, strand, kind))

    five_prime = _utr_available("utr5")
    three_prime = _utr_available("utr3")

    return {
        "genomic":    bool(has_span or exons),
        "transcript": bool(exons),
        "cds":        bool(cds_list),
        "protein":    bool(cds_list),
        "utr5":       five_prime,
        "utr3":       three_prime,
        # The viewer offers one combined UTR entry; either end is enough.
        "utr":        five_prime or three_prime,
        "exons":      bool(exons),
        "introns":    len(exons) >= 2,
    }


def _canonical_info_for_header(tx_data: Dict[str, Any]) -> str:
    """The "[canonical, MANE-select]" note a FASTA header carries.

    MANE status arrives as a GFF tag far more often than as a `mane_status`
    field, so read both — keying off the field alone dropped the note from every
    MANE transcript.
    """
    parts: List[str] = []
    if tx_data.get("is_canonical"):
        parts.append("canonical")

    raw_tags = tx_data.get("tags", [])
    if isinstance(raw_tags, str):
        tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(t) for t in raw_tags]
    else:
        tags = []
    mane_text = " ".join([str(tx_data.get("mane_status", "") or ""), *tags]).lower()
    if "mane" in mane_text and "select" in mane_text:
        parts.append("MANE-select")
    return ", ".join(parts)


def _split_fasta_record(record: str) -> Tuple[str, str]:
    """Split one ``header\\nwrapped sequence`` record into its two halves."""
    header, _, body = record.partition("\n")
    return header, body


@router.post("/api/feature_explorer/transcript_sequences", response_model=TranscriptSequencesResponse)
async def transcript_sequences(payload: TranscriptSequencesRequest):
    """Feature sequences for one transcript, returned rather than written to disk.

    Shares `_extract_feature_records` with /api/feature_explorer/export, so what
    a viewer shows and what an export writes are the same bytes.
    """
    genome = str(payload.genome or "reference").strip() or "reference"
    gene_id = str(payload.gene_id or "").strip()
    tx_id = str(payload.transcript_id or "").strip()
    if not tx_id:
        raise HTTPException(status_code=400, detail="transcript_id must not be empty")

    requested = [str(f).strip() for f in (payload.feature_types or _ALL_FEATURE_TYPES)]
    requested = [f for f in requested if f in set(_ALL_FEATURE_TYPES)]
    if not requested:
        raise HTTPException(status_code=400, detail="feature_types must name at least one known type")

    db_path = await run_in_threadpool(genome_context._get_browse_db, genome)

    def _run():
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute(
            "SELECT id, chrom, start, end, strand, data FROM transcripts WHERE id = ?",
            (tx_id,),
        )
        row = c.fetchone()
        conn.close()
        if not row:
            raise HTTPException(status_code=404, detail=f"Transcript {tx_id} not found in this genome's index")

        chrom = str(row["chrom"] or "")
        strand = str(row["strand"] or "+")
        tx_start = int(row["start"] or 0)
        tx_end = int(row["end"] or 0)
        try:
            tx_data = json.loads(row["data"]) if row["data"] else {}
        except Exception:
            tx_data = {}

        exons    = sequence_windows._normalize_interval_list(tx_data.get("exons",    []), "exon", strand)
        cds_list = sequence_windows._normalize_interval_list(tx_data.get("cds_list", []), "cds",  strand)
        utrs     = sequence_windows._normalize_interval_list(tx_data.get("utrs",     []), "utr",  strand)
        biotype  = str(tx_data.get("biotype", "") or "")

        canonical_info = _canonical_info_for_header(tx_data)

        available = _available_feature_types(
            exons, cds_list, utrs, strand, bool(tx_start and tx_end)
        )

        # Every field on: this is a viewer, and the header is the only place the
        # coordinates and rank are carried.
        header_fields = {
            "exon_number": True, "location": True, "strand": True,
            "length": True, "biotype": True, "canonical_status": True,
        }
        tx_span = (tx_start, tx_end) if tx_start and tx_end else None
        fasta = genome_context._get_browse_fasta(genome)

        records: List[TranscriptSequenceRecord] = []
        errors: List[str] = []
        for feature_type in requested:
            if not available.get(feature_type):
                continue
            try:
                raw = _extract_feature_records(
                    fasta, chrom, strand, exons, cds_list, utrs,
                    feature_type, tx_id, gene_id, header_fields, biotype, canonical_info,
                    tx_genomic_span=tx_span,
                    genome=genome,
                )
                # Amino acids have no complement; reversing one would be noise
                # dressed up as a sequence.
                if payload.reverse_complement and feature_type != "protein":
                    raw = _apply_orientations(raw, ["rev"])
            except Exception as exc:
                errors.append(f"{feature_type}: {exc}")
                continue

            ranked = feature_type in _RANKED_FEATURE_TYPES
            for index, record in enumerate(raw, 1):
                header, body = _split_fasta_record(record)
                records.append(TranscriptSequenceRecord(
                    feature_type=feature_type,
                    header=header,
                    sequence=body,
                    length=len(body.replace("\n", "")),
                    unit="aa" if feature_type == "protein" else "bp",
                    rank=index if ranked else None,
                ))

        return TranscriptSequencesResponse(
            transcript_id=tx_id,
            available=available,
            records=records,
            errors=errors,
        )

    return await run_in_threadpool(_run)


# ─────────────────────────────────────────────────────────────────────────────
# /api/feature_explorer/export
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/api/feature_explorer/export", response_model=ExportSequencesResponse)
async def export_sequences(payload: ExportSequencesRequest):
    """Export transcript feature sequences to FASTA files."""
    genome           = str(payload.genome or "reference").strip() or "reference"
    gene_id          = str(payload.gene_id or "").strip()
    output_structure = str(payload.output_structure or "per_transcript").strip()
    compress         = bool(payload.compress)
    header_fields    = dict(payload.header_fields or {
        "exon_number": True, "location": True, "strand": True,
        "length": True, "biotype": False, "canonical_status": False,
    })

    valid_structures = {"single", "per_transcript", "per_feature"}
    if output_structure not in valid_structures:
        raise HTTPException(status_code=400, detail=f"output_structure must be one of: {', '.join(valid_structures)}")

    transcript_ids = [str(t).strip() for t in (payload.transcript_ids or []) if str(t).strip()]
    feature_types  = [str(f).strip() for f in (payload.feature_types or [])  if str(f).strip()]
    valid_features = {"genomic", "transcript", "cds", "exons", "utr", "utr5", "utr3", "introns", "protein"}
    feature_types  = [f for f in feature_types if f in valid_features]
    orientations   = [str(o).strip() for o in (payload.orientations or ["fwd"]) if str(o).strip() in ("fwd", "rev")]
    if not orientations:
        orientations = ["fwd"]

    if not transcript_ids:
        raise HTTPException(status_code=400, detail="transcript_ids must not be empty")
    if not feature_types:
        raise HTTPException(status_code=400, detail="feature_types must not be empty")
    if not payload.output_dir:
        raise HTTPException(status_code=400, detail="output_dir must not be empty")

    output_dir = Path(str(payload.output_dir)).expanduser().resolve()

    def _run():
        db_path = genome_context._get_browse_db(genome)
        fasta   = genome_context._get_browse_fasta(genome)

        # ── Fetch transcript records from DB ──────────────────────────────────
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        placeholders = ",".join("?" for _ in transcript_ids)
        c.execute(
            f"SELECT id, chrom, start, end, strand, data FROM transcripts WHERE id IN ({placeholders})",
            transcript_ids,
        )
        tx_rows = {
            str(row["id"]): row for row in c.fetchall()
        }
        conn.close()

        # ── Create output directory ───────────────────────────────────────────
        output_dir.mkdir(parents=True, exist_ok=True)

        files_written: List[str] = []
        errors: List[str] = []

        # ── Build per-transcript FASTA records ────────────────────────────────
        # records_by_tx: { tx_id: { feature_type: [fasta_record_str, ...] } }
        records_by_tx: Dict[str, Dict[str, List[str]]] = {}

        # Preserve requested order
        for tx_id in transcript_ids:
            row = tx_rows.get(tx_id)
            if not row:
                errors.append(f"{tx_id}: not found in index — skipped")
                continue

            chrom    = str(row["chrom"] or "")
            strand   = str(row["strand"] or "+")
            tx_start = int(row["start"] or 0)
            tx_end   = int(row["end"]   or 0)
            try:
                tx_data = json.loads(row["data"]) if row["data"] else {}
            except Exception:
                tx_data = {}

            exons    = sequence_windows._normalize_interval_list(tx_data.get("exons",    []), "exon", strand)
            cds_list = sequence_windows._normalize_interval_list(tx_data.get("cds_list", []), "cds",  strand)
            utrs     = sequence_windows._normalize_interval_list(tx_data.get("utrs",     []), "utr",  strand)
            biotype  = str(tx_data.get("biotype", "") or "")

            # Canonical / MANE label for header
            canonical_info = _canonical_info_for_header(tx_data)

            tx_span = (tx_start, tx_end) if tx_start and tx_end else None

            tx_records: Dict[str, List[str]] = {}
            for ft in feature_types:
                try:
                    recs = _extract_feature_records(
                        fasta, chrom, strand, exons, cds_list, utrs,
                        ft, tx_id, gene_id, header_fields, biotype, canonical_info,
                        tx_genomic_span=tx_span,
                        genome=genome,
                    )
                    recs = _apply_orientations(recs, orientations)
                    if recs:
                        tx_records[ft] = recs
                except Exception as e:
                    errors.append(f"{tx_id}/{ft}: {e}")

            if tx_records:
                records_by_tx[tx_id] = tx_records

        if not records_by_tx and not errors:
            errors.append("No sequence records could be extracted for the selected transcripts and features.")

        # ── Write files according to output_structure ─────────────────────────
        ext = ".fa.gz" if compress else ".fa"

        def _open_output(path: Path):
            if compress:
                return gzip.open(path, "wt", encoding="utf-8")
            return open(path, "w", encoding="utf-8")

        def _slug_for_keys(keys: List[str]) -> str:
            if len(keys) == 1:
                return _FEATURE_SLUGS.get(keys[0], keys[0])
            return "mixed_features"

        if output_structure == "single":
            # All records → one file
            filename = str(payload.filename or "").strip()
            if not filename:
                slug = _slug_for_keys(feature_types)
                ts   = datetime.now().strftime("%Y%m%d")
                filename = f"{gene_id or 'export'}_{slug}_{ts}.fa"
                if compress:
                    filename += ".gz"
            out_path = output_dir / filename
            with _open_output(out_path) as fh:
                for tx_id in transcript_ids:
                    tx_recs = records_by_tx.get(tx_id, {})
                    for ft in feature_types:
                        for rec in tx_recs.get(ft, []):
                            fh.write(rec + "\n")
            if out_path.exists() and out_path.stat().st_size > 0:
                files_written.append(str(out_path))
            else:
                errors.append(f"Output file is empty: {out_path}")

        elif output_structure == "per_transcript":
            for tx_id in transcript_ids:
                tx_recs = records_by_tx.get(tx_id)
                if not tx_recs:
                    continue
                present_types = [ft for ft in feature_types if ft in tx_recs]
                slug = _slug_for_keys(present_types)
                out_path = output_dir / f"{tx_id}_{slug}{ext}"
                with _open_output(out_path) as fh:
                    for ft in feature_types:
                        for rec in tx_recs.get(ft, []):
                            fh.write(rec + "\n")
                files_written.append(str(out_path))

        elif output_structure == "per_feature":
            for tx_id in transcript_ids:
                tx_recs = records_by_tx.get(tx_id)
                if not tx_recs:
                    continue
                for ft in feature_types:
                    recs = tx_recs.get(ft)
                    if not recs:
                        continue
                    slug = _FEATURE_SLUGS.get(ft, ft)
                    out_path = output_dir / f"{tx_id}_{slug}{ext}"
                    with _open_output(out_path) as fh:
                        for rec in recs:
                            fh.write(rec + "\n")
                    files_written.append(str(out_path))

        return ExportSequencesResponse(files=files_written, errors=errors)

    return await run_in_threadpool(_run)


@router.post("/api/exports/save", response_model=SaveExportResponse)
async def save_export_file(payload: SaveExportRequest):
    directory_raw = str(payload.directory or "").strip()
    filename = str(payload.filename or "").strip()
    file_format = str(payload.format or "").strip().lower() or "svg"
    encoding = str(payload.encoding or "utf8").strip().lower() or "utf8"
    data = payload.data if isinstance(payload.data, str) else ""

    if not filename:
        raise HTTPException(status_code=400, detail="filename must not be empty")
    if not directory_raw:
        raise HTTPException(status_code=400, detail="directory must not be empty")
    if encoding not in {"utf8", "base64"}:
        raise HTTPException(status_code=400, detail="encoding must be one of: utf8, base64")
    if len(data) > 128 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="export payload is too large")

    directory = Path(directory_raw).expanduser().resolve()
    safe_filename = safe_export_filename(filename, file_format)

    out_path = directory / safe_filename

    def _run():
        directory.mkdir(parents=True, exist_ok=True)
        try:
            if encoding == "base64":
                binary = base64.b64decode(data.encode("utf-8"), validate=True)
                with open(out_path, "wb") as handle:
                    handle.write(binary)
            else:
                with open(out_path, "w", encoding="utf-8") as handle:
                    handle.write(data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 payload: {exc}") from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Failed to write export file: {exc}") from exc

        return SaveExportResponse(ok=True, path=str(out_path), filename=safe_filename)

    return await run_in_threadpool(_run)
