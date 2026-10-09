"""Feature alignment: the pairwise transcript alignment (with flank-aware caching and
reuse of larger cached alignments), multiple alignment of transcripts across genomes
(sharing results with the MSA and Gene Trees views), saved alignment workspaces, and
recently viewed transcripts.
"""

import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from collections import Counter
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pysam
from Bio.Seq import Seq
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import app_paths
import config_store
import file_io
import genome_context
import gff_index
import mafft
import transcript_msa
from assembly_report import chrom_token_variants
from transcript_msa.regions import (
    params_of as _tmsa_params_of,
    structure_hash as _tmsa_structure_hash,
    window_region as _tmsa_window_region,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ============ Data Models ============

class AlignmentRequest(BaseModel):
    transcript_id: str
    target_transcript_id: Optional[str] = None  # If set, use this ID for target GFF3 lookup
    ref_flank_bp: int = 100  # Flanking for reference sequence
    tgt_flank_bp: int = 100  # Flanking for target sequence
    flank_bp: int = 100  # Legacy: used if ref/tgt not provided
    ref_fasta: Optional[str] = None
    ref_gff: Optional[str] = None
    target_fasta: Optional[str] = None
    target_gff: Optional[str] = None


class Feature(BaseModel):
    type: str
    start: int
    end: int
    original_start: int
    original_end: int
    codon_phase: Optional[int] = None


class AlignedRegion(BaseModel):
    name: str
    sequence: str
    features: List[Feature]
    chrom: str
    genomic_start: int
    genomic_end: int
    strand: str


class AlignmentResult(BaseModel):
    transcript_id: str
    reference: AlignedRegion
    target: AlignedRegion
    alignment_length: int
    identity: float
    gaps: int
    timestamp: str


class MultiAlignmentRowRequest(BaseModel):
    genome: str
    genome_key: Optional[str] = None
    tag: Optional[str] = None
    query: Optional[str] = None
    transcript_id: Optional[str] = None
    selected_transcript_id: Optional[str] = None
    include: bool = True
    flank_5_bp: int = 100
    flank_3_bp: int = 100
    overlay_annotation: bool = True
    use_gene_boundaries: bool = True


class MultiAlignmentRunSettings(BaseModel):
    profile: str = "balanced"  # accurate | balanced | fast
    soft_warn_sequences: int = 6
    hard_cap_sequences: int = 10
    max_total_bp: int = 500_000
    timeout_sec: int = 300
    divergence_mode: str = "auto"  # auto | detail | summary


class MultiAlignmentRequest(BaseModel):
    rows: List[MultiAlignmentRowRequest]
    run_settings: MultiAlignmentRunSettings = MultiAlignmentRunSettings()
    run_scope: str = "resolved_subset"


class MultiAlignmentExcludedRow(BaseModel):
    genome: str
    genome_key: str = ""
    tag: str = ""
    query: str = ""
    transcript_id: str = ""
    reason: str


class MultiAlignedRow(BaseModel):
    genome: str
    genome_key: str = ""
    tag: str = ""
    query: str = ""
    transcript_id: str
    chrom: str
    genomic_start: int
    genomic_end: int
    strand: str
    aligned_sequence: str
    raw_length: int
    flank_5_bp: int = 100
    flank_3_bp: int = 100
    overlay_annotation: bool = True
    use_gene_boundaries: bool = True
    features: List[Feature] = []
    identity_to_consensus: float = 0.0
    gap_fraction: float = 0.0


class MultiAlignmentResult(BaseModel):
    timestamp: str
    alignment_length: int
    requested_count: int
    included_count: int
    profile: str
    strategy: str
    consensus: str
    average_identity: float = 0.0
    warnings: List[str] = []
    rows: List[MultiAlignedRow]
    excluded_rows: List[MultiAlignmentExcludedRow] = []
    cache_hit: bool = False


class RecentItem(BaseModel):
    transcript_id: str
    target_transcript_id: str = ""
    timestamp: str
    identity: float


# ============ Global State (lightweight) ============

class GenomeData:
    """Cached FASTA handles only - GFF3 is searched on demand."""
    def __init__(self):
        self.ref_fasta: Optional["ThreadSafeFasta"] = None
        self.target_fasta: Optional["ThreadSafeFasta"] = None
        self.ref_fasta_path: Optional[str] = None
        self.target_fasta_path: Optional[str] = None

    def load_fasta(self, ref_fasta: str, target_fasta: str):
        """Load FASTA files if not already loaded. Handles both plain and bgzipped (.gz) FASTA."""
        if self.ref_fasta_path != ref_fasta:
            file_io.log_progress(f"Loading reference FASTA: {Path(ref_fasta).name}")
            self.ref_fasta = file_io.open_indexed_fasta(ref_fasta)
            self.ref_fasta_path = ref_fasta
            file_io.log_progress("  ✓ Reference FASTA loaded")

        if self.target_fasta_path != target_fasta:
            file_io.log_progress(f"Loading target FASTA: {Path(target_fasta).name}")
            self.target_fasta = file_io.open_indexed_fasta(target_fasta)
            self.target_fasta_path = target_fasta
            file_io.log_progress("  ✓ Target FASTA loaded")


genome_data = GenomeData()


recent_transcripts: List[RecentItem] = []


def extract_genomic_sequence(
    fasta: pysam.FastaFile,
    chrom: str,
    start: int,
    end: int,
    strand: str,
    uppercase: bool = True,
) -> str:
    """Extract sequence from FASTA, reverse complement if needed."""
    seq = fasta.fetch(chrom, start - 1, end)
    if strand == "-":
        seq = str(Seq(seq).reverse_complement())
    return seq.upper() if uppercase else str(seq)


def _multi_alignment_cache_dir(output_dir: Optional[str]) -> Optional[Path]:
    root = str(output_dir or "").strip()
    if not root:
        return None
    try:
        cache_dir = Path(root).expanduser().resolve() / "alignment_cache_multi"
        cache_dir.mkdir(parents=True, exist_ok=True)
        return cache_dir
    except Exception:
        return None


def _stable_json_hash(payload: Dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _transcript_window_with_oriented_flanks(
    tx: gff_index.SimpleTranscript,
    flank_5_bp: int,
    flank_3_bp: int,
) -> Tuple[int, int]:
    return _interval_window_with_oriented_flanks(int(tx.start), int(tx.end), str(tx.strand or "+"), flank_5_bp, flank_3_bp)


def _interval_window_with_oriented_flanks(
    start: int,
    end: int,
    strand: str,
    flank_5_bp: int,
    flank_3_bp: int,
) -> Tuple[int, int]:
    f5 = max(0, int(flank_5_bp))
    f3 = max(0, int(flank_3_bp))
    left = min(int(start), int(end))
    right = max(int(start), int(end))
    if str(strand or "+") == "-":
        start = max(1, left - f3)
        end = right + f5
    else:
        start = max(1, left - f5)
        end = right + f3
    return start, end


def _find_parent_gene_boundaries(genome: str, transcript_id: str) -> Tuple[Optional[int], Optional[int]]:
    """Look up the parent gene's genomic boundaries for a transcript.

    Returns (gene_start, gene_end) or (None, None) if not found.
    """
    try:
        context = genome_context._resolve_browse_genome_context(genome)
    except Exception:
        return None, None
    db_path = str(context.get("db_path") or "").strip()
    if not db_path or not os.path.exists(db_path):
        return None, None

    search_id = transcript_id.replace("transcript:", "").replace("mapped_transcript:", "")
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute(
            "SELECT parent_gene_id FROM transcripts WHERE id = ?",
            (search_id,),
        )
        tx_row = c.fetchone()
        if not tx_row or not tx_row["parent_gene_id"]:
            conn.close()
            return None, None
        parent_gene_id = str(tx_row["parent_gene_id"])
        c.execute(
            "SELECT start, end FROM genes WHERE id = ?",
            (parent_gene_id,),
        )
        gene_row = c.fetchone()
        conn.close()
        if not gene_row:
            return None, None
        return int(gene_row["start"]), int(gene_row["end"])
    except Exception:
        return None, None


def _find_transcript_for_genome(genome: str, transcript_id: str) -> Optional[gff_index.SimpleTranscript]:
    context = genome_context._resolve_browse_genome_context(genome)
    db_path = str(context.get("db_path") or "").strip()
    gff_path = str(context.get("gff_path") or "").strip()

    tx: Optional[gff_index.SimpleTranscript] = None
    if db_path and os.path.exists(db_path):
        tx = gff_index.find_transcript_in_index(db_path, transcript_id)
    if tx is None and gff_path and os.path.exists(gff_path):
        tx = gff_index.find_transcript_fast(gff_path, transcript_id)
    return tx


def _resolve_transcript_id_for_genome_query(genome: str, query: str) -> str:
    q = str(query or "").strip()
    if not q:
        return ""
    try:
        context = genome_context._resolve_browse_genome_context(genome)
    except Exception:
        return ""
    db_path = str(context.get("db_path") or "").strip()
    if not db_path or not os.path.exists(db_path):
        return ""

    conn = None
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()

        # 1) Transcript ID exact / case-insensitive
        c.execute("SELECT id FROM transcripts WHERE id = ? LIMIT 1", (q,))
        row = c.fetchone()
        if row and row.get("id"):
            return str(row["id"])
        c.execute("SELECT id FROM transcripts WHERE LOWER(id) = LOWER(?) LIMIT 1", (q,))
        row = c.fetchone()
        if row and row.get("id"):
            return str(row["id"])

        # 2) Resolve gene id by name/id, then pick canonical (or earliest) transcript
        gene_id = None
        for sql, params in [
            ("SELECT id FROM genes WHERE LOWER(name) = LOWER(?) LIMIT 1", (q,)),
            ("SELECT id FROM genes WHERE LOWER(id) = LOWER(?) LIMIT 1", (q,)),
            ("SELECT id FROM genes WHERE LOWER(name) LIKE LOWER(?) LIMIT 1", (f"%{q}%",)),
        ]:
            try:
                c.execute(sql, params)
                row = c.fetchone()
            except sqlite3.OperationalError:
                row = None
            if row and row.get("id"):
                gene_id = str(row["id"])
                break

        if not gene_id:
            return ""

        try:
            c.execute(
                "SELECT id FROM transcripts WHERE parent_gene_id = ? ORDER BY is_canonical DESC, start ASC LIMIT 1",
                (gene_id,),
            )
            row = c.fetchone()
            if row and row.get("id"):
                return str(row["id"])
        except sqlite3.OperationalError:
            pass

        try:
            c.execute(
                "SELECT id FROM transcripts WHERE parent_gene_id = ? LIMIT 1",
                (gene_id,),
            )
            row = c.fetchone()
            if row and row.get("id"):
                return str(row["id"])
        except sqlite3.OperationalError:
            pass
    except Exception:
        return ""
    finally:
        try:
            if conn is not None:
                conn.close()
        except Exception:
            pass
    return ""


def _extract_sequence_for_alignment_row(
    genome: str,
    fasta: pysam.FastaFile,
    chrom: str,
    start: int,
    end: int,
    strand: str,
) -> Tuple[str, str, int, int]:
    requested_chrom = str(chrom or "").strip()
    if not requested_chrom:
        raise RuntimeError("missing chromosome/region name")

    def _build_candidates(known_regions: List[str]) -> List[str]:
        known_by_lower = {k.lower(): k for k in known_regions}
        out: List[str] = []

        def _add(value: Optional[str]) -> None:
            token = str(value or "").strip()
            if not token:
                return
            if token not in out:
                out.append(token)
            mapped = known_by_lower.get(token.lower())
            if mapped and mapped not in out:
                out.append(mapped)

        _add(requested_chrom)
        try:
            resolved = genome_context._resolve_browse_chrom_name(genome, requested_chrom, known_regions)
        except Exception:
            resolved = ""
        _add(resolved)
        for token in chrom_token_variants(requested_chrom):
            _add(token)
        return out or [requested_chrom]

    def _try_fetch(handle: pysam.FastaFile, candidates: List[str]) -> Tuple[Optional[Tuple[str, str, int, int]], List[str], bool]:
        errors: List[str] = []
        all_unknown_region = True
        for candidate in candidates:
            try:
                chrom_len = int(handle.get_reference_length(candidate))
                all_unknown_region = False
            except Exception as exc:
                errors.append(f"{candidate}: unknown region ({exc})")
                continue

            lo = max(1, int(start or 1))
            hi = max(1, int(end or lo))
            if hi < lo:
                lo, hi = hi, lo

            if chrom_len <= 0:
                errors.append(f"{candidate}: empty contig")
                continue

            lo = min(lo, chrom_len)
            hi = min(max(lo, hi), chrom_len)

            try:
                seq = extract_genomic_sequence(handle, candidate, lo, hi, strand, uppercase=False)
            except Exception as exc:
                errors.append(f"{candidate}:{lo}-{hi} ({exc})")
                continue

            if seq:
                return (seq, candidate, lo, hi), errors, all_unknown_region
            errors.append(f"{candidate}:{lo}-{hi} (empty)")
        return None, errors, all_unknown_region

    def _stream_fetch_fallback(candidates: List[str]) -> Optional[Tuple[str, str, int, int]]:
        try:
            context = genome_context._resolve_browse_genome_context(genome)
            source_path = str(context.get("fasta_path") or "").strip()
        except Exception:
            source_path = ""
        if not source_path or not os.path.exists(source_path):
            return None

        lo = max(1, int(start or 1))
        hi = max(1, int(end or lo))
        if hi < lo:
            lo, hi = hi, lo

        candidate_lookup = {str(c or "").strip().lower() for c in candidates if str(c or "").strip()}
        if not candidate_lookup:
            candidate_lookup = {requested_chrom.lower()}

        current_name = ""
        in_target = False
        pos = 1
        chunks: List[str] = []

        with file_io.open_maybe_gz(source_path, "rt") as handle:
            for raw_line in handle:
                line = str(raw_line or "").strip()
                if not line:
                    continue
                if line.startswith(">"):
                    header_name = line[1:].strip().split()[0] if line[1:].strip() else ""
                    if in_target:
                        break
                    current_name = header_name
                    in_target = header_name.lower() in candidate_lookup
                    pos = 1
                    continue

                if not in_target:
                    continue

                seq_line = line
                line_len = len(seq_line)
                if line_len <= 0:
                    continue
                line_start = pos
                line_end = pos + line_len - 1
                if line_end < lo:
                    pos += line_len
                    continue
                if line_start > hi:
                    break

                left = max(0, lo - line_start)
                right = min(line_len, hi - line_start + 1)
                if right > left:
                    chunks.append(seq_line[left:right])
                pos += line_len
                if pos > hi:
                    break

        if not chunks:
            return None

        seq = "".join(chunks)
        if strand == "-":
            seq = str(Seq(seq).reverse_complement())
        return str(seq), current_name, lo, hi

    known_regions = [str(r or "").strip() for r in list(fasta.references or []) if str(r or "").strip()]
    first_candidates = _build_candidates(known_regions)
    result, first_errors, first_all_unknown = _try_fetch(fasta, first_candidates)
    if result is not None:
        return result

    # Recovery path for stale/truncated FASTA index files: force reindex once and retry.
    if first_all_unknown:
        try:
            refreshed_fasta = genome_context._force_refresh_browse_fasta_index(genome, current_fasta=fasta)
            refreshed_regions = [
                str(r or "").strip()
                for r in list(refreshed_fasta.references or [])
                if str(r or "").strip()
            ]
            retry_candidates = _build_candidates(refreshed_regions)
            retry_result, retry_errors, _ = _try_fetch(refreshed_fasta, retry_candidates)
            if retry_result is not None:
                return retry_result
            first_errors.extend([f"retry:{msg}" for msg in retry_errors[:8]])
        except Exception as exc:
            first_errors.append(f"retry_failed: {exc}")

        streamed = _stream_fetch_fallback(first_candidates)
        if streamed is not None:
            return streamed
        first_errors.append("stream_fallback_failed: no matching FASTA contig sequence found")

    detail = "; ".join(first_errors[:8]) if first_errors else "unknown fetch failure"
    raise RuntimeError(f"unable to fetch sequence for {requested_chrom}:{start}-{end} ({detail})")


def _build_consensus_from_aligned_rows(aligned_sequences: List[str]) -> str:
    if not aligned_sequences:
        return ""
    aln_len = len(aligned_sequences[0])
    if aln_len <= 0:
        return ""
    out: List[str] = []
    for i in range(aln_len):
        col = [seq[i] for seq in aligned_sequences if i < len(seq)]
        non_gap = [c for c in col if c != "-"]
        if not non_gap:
            out.append("-")
            continue
        counts = Counter(non_gap)
        best = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        out.append(best)
    return "".join(out)


def _identity_to_consensus(seq: str, consensus: str) -> float:
    if not seq or not consensus:
        return 0.0
    matches = 0
    denom = 0
    for a, c in zip(seq, consensus):
        if a == "-" and c == "-":
            continue
        if c == "-":
            continue
        denom += 1
        if a == c:
            matches += 1
    if denom <= 0:
        return 0.0
    return float(matches) / float(denom) * 100.0


def _gap_fraction(seq: str) -> float:
    if not seq:
        return 0.0
    return float(seq.count("-")) / float(max(1, len(seq)))


def map_features_to_alignment(
    transcript: gff_index.SimpleTranscript,
    genomic_start: int,
    genomic_end: int,
    aligned_seq: str,
    strand: str,
    raw_genomic_seq: str = ""
) -> List[Feature]:
    """Map genomic features to alignment coordinates with priority ordering.
    
    Priority (highest first): start/stop/splice > UTR/CDS > exon/intron
    """
    features = []
    
    genomic_len = genomic_end - genomic_start + 1
    genomic_to_aln = {}
    
    genomic_pos = 0
    for aln_pos, base in enumerate(aligned_seq):
        if base != '-':
            genomic_to_aln[genomic_pos] = aln_pos
            genomic_pos += 1
    
    def genomic_to_alignment_range(gstart: int, gend: int) -> Tuple[int, int]:
        if strand == "+":
            rel_start = gstart - genomic_start
            rel_end = gend - genomic_start
        else:
            rel_start = genomic_end - gend
            rel_end = genomic_end - gstart
        
        rel_start = max(0, min(rel_start, genomic_len - 1))
        rel_end = max(0, min(rel_end, genomic_len - 1))
        
        aln_start = genomic_to_aln.get(rel_start, 0)
        aln_end = genomic_to_aln.get(rel_end, len(aligned_seq) - 1)
        
        return aln_start, aln_end
    
    def add_feature(ftype: str, gstart: int, gend: int, priority: int):
        if gstart > genomic_end or gend < genomic_start:
            return
        aln_start, aln_end = genomic_to_alignment_range(gstart, gend)
        features.append({
            'type': ftype,
            'start': aln_start,
            'end': aln_end,
            'original_start': gstart,
            'original_end': gend,
            'priority': priority
        })
    
    # Priority 3: Exons and Introns (lowest)
    for exon in transcript.exons:
        add_feature('exon', exon.start, exon.end, 3)
    
    # Infer introns between exons
    sorted_exons = sorted(transcript.exons, key=lambda e: e.start)
    for i in range(len(sorted_exons) - 1):
        intron_start = sorted_exons[i].end + 1
        intron_end = sorted_exons[i + 1].start - 1
        if intron_end >= intron_start:
            add_feature('intron', intron_start, intron_end, 3)
    
    # Priority 2: CDS and UTRs
    for cds in transcript.cds_list:
        add_feature('cds', cds.start, cds.end, 2)
    
    for utr in transcript.utrs:
        utr_type = 'utr5' if utr.feature_type == 'five_prime_UTR' else 'utr3'
        add_feature(utr_type, utr.start, utr.end, 2)
    
    # Priority 1: Splice sites, Start/Stop codons (highest)
    # Infer splice sites from exon boundaries (check canonical GT/AG)
    # Sort exons biologically:
    # (+) strand: start -> end (Ascending)
    # (-) strand: end -> start (Descending)
    sorted_exons = sorted(transcript.exons, key=lambda e: e.start, reverse=(strand == '-'))
    
    for i, exon in enumerate(sorted_exons):
        # Donor (5' splice site) - after exon
        if i < len(sorted_exons) - 1:
            if strand == '+':
                # (+) Donor: GT at exon.end + 1, + 2
                gstart, gend = exon.end + 1, exon.end + 2
                # (+) Index: gstart - genomic_start
                seq_idx = gstart - genomic_start
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'GT':
                        add_feature('donor', gstart, gend, 1)
            else:
                # (-) Donor: GT (flanking exon 3' end, which is exon.start)
                # Genomic coords: exon.start - 1, exon.start - 2 (High -> Low)
                # RC Index: genomic_end - coord
                # Base 1 (GT[0]): exon.start - 1 (gend) -> index = genomic_end - (exon.start - 1)
                gstart, gend = exon.start - 2, exon.start - 1
                seq_idx = genomic_end - gend
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'GT': # Check GT directly in RC sequence
                        add_feature('donor', gstart, gend, 1)

        # Acceptor (3' splice site) - before exon
        if i > 0:
            if strand == '+':
                # (+) Acceptor: AG at exon.start - 2, - 1
                gstart, gend = exon.start - 2, exon.start - 1
                seq_idx = gstart - genomic_start
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'AG':
                        add_feature('acceptor', gstart, gend, 1)
            else:
                # (-) Acceptor: AG (flanking exon 5' start, which is exon.end)
                # Genomic coords: exon.end + 2, exon.end + 1 (High -> Low)
                # RC Index: genomic_end - coord
                # Base 1 (AG[0]): exon.end + 2 (gend) -> index = genomic_end - (exon.end + 2)
                gstart, gend = exon.end + 1, exon.end + 2
                seq_idx = genomic_end - gend
                if 0 <= seq_idx < len(raw_genomic_seq) - 1:
                    site_seq = raw_genomic_seq[seq_idx:seq_idx+2].upper()
                    if site_seq == 'AG': # Check AG directly in RC sequence
                        add_feature('acceptor', gstart, gend, 1)
    
    # Infer start/stop codons from CDS boundaries
    if transcript.cds_list:
        sorted_cds = sorted(transcript.cds_list, key=lambda c: c.start)
        if strand == '+':
            # Start codon at beginning of first CDS
            cds_start = sorted_cds[0].start
            add_feature('start_codon', cds_start, cds_start + 2, 1)
            # Stop codon at end of last CDS
            cds_end = sorted_cds[-1].end
            add_feature('stop_codon', cds_end - 2, cds_end, 1)
        else:
            # For minus strand, start is at the end, stop at the beginning
            cds_end = sorted_cds[-1].end
            add_feature('start_codon', cds_end - 2, cds_end, 1)
            cds_start = sorted_cds[0].start
            add_feature('stop_codon', cds_start, cds_start + 2, 1)
    
    # Sort features by priority (lower number = higher priority) so higher priority drawn last
    features.sort(key=lambda f: -f['priority'])
    
    # Convert to Feature objects
    result = []
    for f in features:
        result.append(Feature(
            type=f['type'],
            start=f['start'],
            end=f['end'],
            original_start=f['original_start'],
            original_end=f['original_end']
        ))
    
    return result


def calculate_identity(seq1: str, seq2: str) -> Tuple[float, int]:
    """Calculate identity and gap count between aligned sequences."""
    matches = 0
    gaps = 0
    total = 0
    
    for a, b in zip(seq1, seq2):
        if a == '-' or b == '-':
            gaps += 1
        else:
            total += 1
            if a == b:
                matches += 1
    
    identity = (matches / total * 100) if total > 0 else 0
    return identity, gaps


def get_cache_path(transcript_id: str, target_id: str, ref_flank: int = 0, tgt_flank: int = 0) -> Path:
    """Get cache path including flanking info and target ID."""
    safe_id = transcript_id.replace(":", "_").replace("/", "_")
    safe_target = target_id.replace(":", "_").replace("/", "_")
    return app_paths.CACHE_DIR / f"{safe_id}_vs_{safe_target}_rf{ref_flank}_tf{tgt_flank}.json"


def get_max_flanking_cache(transcript_id: str, target_id: str) -> Optional[Tuple[Path, int, int]]:
    """Find the cached alignment with the largest flanking for this transcript pair."""
    import re
    safe_id = transcript_id.replace(":", "_").replace("/", "_")
    safe_target = target_id.replace(":", "_").replace("/", "_")
    pattern = f"{safe_id}_vs_{safe_target}_rf*_tf*.json"
    
    best_path = None
    best_ref_flank = -1
    best_tgt_flank = -1
    
    for path in app_paths.CACHE_DIR.glob(pattern):
        # Extract flanking values from filename
        match = re.search(r'_rf(\d+)_tf(\d+)\.json$', path.name)
        if match:
            ref_flank = int(match.group(1))
            tgt_flank = int(match.group(2))
            # Prefer larger cached alignments
            if ref_flank >= best_ref_flank and tgt_flank >= best_tgt_flank:
                best_path = path
                best_ref_flank = ref_flank
                best_tgt_flank = tgt_flank
    
    if best_path:
        return best_path, best_ref_flank, best_tgt_flank
    return None


def load_from_cache(transcript_id: str, target_id: str, ref_flank: int, tgt_flank: int) -> Optional[AlignmentResult]:
    """Load from cache if exact match exists or if a larger cached alignment can be subset."""
    # First try exact match
    cache_path = get_cache_path(transcript_id, target_id, ref_flank, tgt_flank)
    if cache_path.exists():
        try:
            with open(cache_path) as f:
                data = json.load(f)
                file_io.log_progress("  ✓ Found exact cache match")
                return AlignmentResult(**data)
        except Exception:
            pass
    
    # Try to find a larger cached alignment
    larger = get_max_flanking_cache(transcript_id, target_id)
    if larger:
        path, cached_ref_flank, cached_tgt_flank = larger
        if cached_ref_flank >= ref_flank and cached_tgt_flank >= tgt_flank:
            file_io.log_progress(f"  ✓ Found larger cache (rf{cached_ref_flank}, tf{cached_tgt_flank}), can subset")
            # For now, just return the larger alignment - client handles display
            # A full implementation would extract sub-alignment here
            try:
                with open(path) as f:
                    data = json.load(f)
                    return AlignmentResult(**data)
            except Exception:
                pass
    
    return None


def save_to_cache(result: AlignmentResult, target_id: str, ref_flank: int, tgt_flank: int):
    """Save alignment to cache with flanking info in filename."""
    cache_path = get_cache_path(result.transcript_id, target_id, ref_flank, tgt_flank)
    try:
        with open(cache_path, 'w') as f:
            json.dump(result.model_dump(), f)
        file_io.log_progress(f"  ✓ Saved to cache: {cache_path.name}")
    except Exception as e:
        file_io.log_progress(f"  ✗ Failed to save cache: {e}")


def get_alignment_cache_path(output_dir: str, ref_id: str, tgt_id: str, ref_flank: int, tgt_flank: int) -> Optional[str]:
    """Generate a consistent cache file path for an alignment."""
    if not output_dir:
        return None
        
    # Sanitize IDs for filenames
    safe_ref = ref_id.replace(":", "_").replace("/", "_")
    safe_tgt = tgt_id.replace(":", "_").replace("/", "_")
    
    filename = f"align_{safe_ref}_{safe_tgt}_{ref_flank}_{tgt_flank}.json"
    cache_dir = os.path.join(output_dir, "alignment_cache")
    
    if not os.path.exists(cache_dir):
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except:
            return None
            
    return os.path.join(cache_dir, filename)


def find_compatible_cache(output_dir: str, ref_id: str, tgt_id: str, req_ref: int, req_tgt: int) -> Tuple[Optional[str], int, int]:
    """Find a cache file that covers at least the requested flanking regions."""
    logger.debug("Searching alignment cache: dir=%s, ref=%s, tgt=%s, req=(%s,%s)", output_dir, ref_id, tgt_id, req_ref, req_tgt)

    if not output_dir:
        return None, 0, 0
        
    cache_dir = Path(output_dir) / "alignment_cache"
    if not cache_dir.exists():
        return None, 0, 0
        
    safe_ref = ref_id.replace(":", "_").replace("/", "_")
    safe_tgt = tgt_id.replace(":", "_").replace("/", "_")
    prefix = f"align_{safe_ref}_{safe_tgt}_"
    
    best_path = None
    best_area = float('inf')
    found_ref = 0
    found_tgt = 0
    
    try:
        for f in cache_dir.iterdir():
            if f.name.startswith(prefix) and f.name.endswith(".json"):
                # Parse flanks from filename: align_{ref}_{tgt}_{ref_flank}_{tgt_flank}.json
                try:
                    parts = f.stem.split('_')
                    # We expect at least 4 parts, but ref/tgt might have underscores.
                    # We know the suffixes are the last 2 digits
                    c_tgt_flank = int(parts[-1])
                    c_ref_flank = int(parts[-2])
                    
                    logger.debug("  Checking alignment cache candidate: %s -> (%s, %s)", f.name, c_ref_flank, c_tgt_flank)
                    
                    if c_ref_flank >= req_ref and c_tgt_flank >= req_tgt:
                        # Found compatible cache
                        # Prefer smaller area to minimize truncation overhead? 
                        # Or larger? Doesn't matter much, just pick one.
                        area = c_ref_flank * c_tgt_flank
                        if area < best_area:
                            best_area = area
                            best_path = str(f)
                            found_ref = c_ref_flank
                            found_tgt = c_tgt_flank
                except:
                    continue
    except Exception as e:
        logger.error(f"Error searching cache: {e}")
        
    return best_path, found_ref, found_tgt


def truncate_and_mask_alignment(result: AlignmentResult, cached_ref: int, cached_tgt: int, req_ref: int, req_tgt: int) -> AlignmentResult:
    """Mask excess flanking regions with gaps and trim empty columns."""
    
    # Calculate how much to trim (per side) from the ORIGINAL sequence perspective
    trim_r = cached_ref - req_ref
    trim_t = cached_tgt - req_tgt
    
    if trim_r == 0 and trim_t == 0:
        return result
        
    # We need to mask the characters that correspond to the outer `trim` bases
    # This preserves alignment but hides the specific sequence
    
    # Helper to mask a sequence string
    # We need to know which characters are "real" bases vs gaps
    def mask_sequence(aligned_seq: str, trim_amount: int) -> str:
        if trim_amount <= 0:
            return aligned_seq
            
        chars = list(aligned_seq)
        orig_len = len([c for c in chars if c != '-'])
        
        current_idx = 0
        for i, char in enumerate(chars):
            if char != '-':
                # Check if this base is in the trim region
                # Left trim: 0 to trim_amount - 1
                # Right trim: (orig_len - trim_amount) to orig_len - 1
                if current_idx < trim_amount or current_idx >= (orig_len - trim_amount):
                    chars[i] = '-'
                current_idx += 1
        return "".join(chars)

    # Mask both sequences
    # Note: result.reference.sequence is the ALIGNED sequence
    new_ref_seq = mask_sequence(result.reference.sequence, trim_r)
    new_tgt_seq = mask_sequence(result.target.sequence, trim_t)
    
    # Now valid characters might be surrounded by gap-only columns
    # We can trim columns where BOTH sequences are gaps
    # But ONLY at the ends (flanking regions), to assume internal gaps are real alignment features
    
    # Logic: 
    # Zip sequences -> identify columns
    # Find first column that is NOT (-,-)
    # Find last column that is NOT (-,-)
    # Slice
    
    # Wait: internal gaps might be (-,-) if aligner inserted them? Unlikely/impossible for MAFFT (gap-gap).
    # But if we masked separate regions (e.g. Ref masked but Tgt present), we keep those.
    # We only drop columns that are effectively "padding" now.
    
    cols = []
    for r, t in zip(new_ref_seq, new_tgt_seq):
        cols.append((r, t))
        
    first_valid = 0
    last_valid = len(cols) - 1
    
    # scan forward
    for i, (r, t) in enumerate(cols):
        if r != '-' or t != '-':
            first_valid = i
            break
            
    # scan backward
    for i in range(len(cols) - 1, -1, -1):
        r, t = cols[i]
        if r != '-' or t != '-':
            last_valid = i
            break
            
    if last_valid < first_valid:
        # Empty alignment? fallback
        return result
        
    # Slice
    sliced_ref = new_ref_seq[first_valid : last_valid+1]
    sliced_tgt = new_tgt_seq[first_valid : last_valid+1]
    
    # Update Genomic Start/End
    # Ref start increases by trim_r
    # Ref end decreases by trim_r
    # (Extract logic: start = tx.start - flank. If shrink flank by N, start increases by N)
    
    # Fix Features: shift alignment coordinates now that we sliced the sequence.
    # Features have 'start'/'end' in ALIGNED coordinates (0-indexed).
    # We dropped `first_valid` columns from the left, so every coordinate
    # needs to be decremented by that amount.
    def shift_features(features, shift):
        new_feats = []
        new_len = len(sliced_ref)
        for f in features:
            s = f.start - shift
            e = f.end - shift

            # Drop features that fall entirely outside the new window
            if e < 0 or s >= new_len:
                continue

            # Clamp to valid range
            s = max(0, s)
            e = min(new_len - 1, e)

            if s <= e:
                # Use model_copy(update={}) – the Pydantic v2 safe way to
                # produce a modified copy without mutating the original.
                new_feats.append(f.model_copy(update={"start": s, "end": e}))
        return new_feats

    ref_features_shifted = shift_features(result.reference.features, first_valid)
    tgt_features_shifted = shift_features(result.target.features, first_valid)

    # Build updated AlignedRegion objects using model_copy(update={}) so we
    # never attempt in-place mutation on a potentially immutable Pydantic model.
    new_ref_reg = result.reference.model_copy(update={
        "sequence": sliced_ref,
        "genomic_start": result.reference.genomic_start + trim_r,
        "genomic_end": result.reference.genomic_end - trim_r,
        "features": ref_features_shifted,
    })
    new_tgt_reg = result.target.model_copy(update={
        "sequence": sliced_tgt,
        "genomic_start": result.target.genomic_start + trim_t,
        "genomic_end": result.target.genomic_end - trim_t,
        "features": tgt_features_shifted,
    })
    
    # Recalculate stats
    ident, gaps = calculate_identity(sliced_ref, sliced_tgt)
    
    return AlignmentResult(
        transcript_id=result.transcript_id,
        reference=new_ref_reg,
        target=new_tgt_reg,
        alignment_length=len(sliced_ref),
        identity=ident,
        gaps=gaps,
        timestamp=result.timestamp
    )


@router.post("/api/align", response_model=AlignmentResult)
def align_transcripts(request: AlignmentRequest):
    """Align two transcripts with flanking sequences.

    Defined with ``def`` rather than ``async def`` so FastAPI runs it on a worker
    thread. Nothing in here awaits, and an alignment takes anything from seconds to
    minutes; on the event loop that was minutes in which the process answered no
    request at all, including the ones the rest of the UI needs to stay responsive.
    """
    config = config_store.load_config()
    output_dir = config.get("output_dir")
    
    # Determine flanking values.
    # ref_flank_bp / tgt_flank_bp are the per-sequence sliders (default 100).
    # flank_bp is the legacy single-slider (default 100).
    # Per-sequence fields take priority; only fall back to the legacy field
    # when the per-sequence field still equals the shared default (100) and
    # the legacy field has been explicitly set to something different.
    ref_flank = request.ref_flank_bp if (request.ref_flank_bp != 100 or request.flank_bp == 100) else request.flank_bp
    tgt_flank = request.tgt_flank_bp if (request.tgt_flank_bp != 100 or request.flank_bp == 100) else request.flank_bp
    
    # Determine target ID early for cache lookup
    target_id = request.target_transcript_id or request.transcript_id

    # Check cache first (smart lookup)
    cache_path, c_ref, c_tgt = find_compatible_cache(
        output_dir, 
        request.transcript_id, 
        target_id,
        ref_flank,
        tgt_flank
    )
    
    
    if cache_path and os.path.exists(cache_path):
        try:
            logger.debug("Attempting to load alignment cache: %s", cache_path)
            file_io.log_progress(f"Found compatible cache: {Path(cache_path).name} ({c_ref}/{c_tgt} vs {ref_flank}/{tgt_flank})")
            with open(cache_path, 'r') as f:
                data = json.load(f)
                cached_result = AlignmentResult(**data)
                
            # Truncate if necessary (if cached flanks > requested)
            file_io.log_progress(f"Adapting cache: {c_ref}->{ref_flank}, {c_tgt}->{tgt_flank}")
            final_result = truncate_and_mask_alignment(cached_result, c_ref, c_tgt, ref_flank, tgt_flank)
            file_io.log_progress("  ✓ Loaded and adapted from cache")
            return final_result
            
        except Exception as e:
            import traceback
            trace_msg = traceback.format_exc()
            
            # Log to console/logger
            logger.error(f"Failed to load/adapt cache: {e}")
            logger.error(trace_msg)
            file_io.log_progress(f"  ✗ Cache adaptation failed: {e}")
            # Continue to re-run alignment if cache load fails
    
    ref_fasta = config.get("ref_fasta")
    ref_gff = config.get("ref_gff")

    file_io.log_progress(f"\n{'='*60}")
    file_io.log_progress(f"Alignment request: {request.transcript_id}")
    file_io.log_progress(f"{'='*60}")
    
    # Get config if not provided in request
    ref_fasta = request.ref_fasta or config.get("ref_fasta")
    ref_gff = request.ref_gff or config.get("ref_gff")
    target_fasta = request.target_fasta or config.get("target_fasta")
    target_gff = config.get("target_gff") # Always from config for now as UI doesn't send separate target GFF path usually?
    if request.target_gff: target_gff = request.target_gff

    # Validate paths
    if not (ref_fasta and ref_gff and target_fasta and target_gff):
        raise HTTPException(
            status_code=400, 
            detail="Genome files not configured. Please set paths in Configuration View."
        )
    
    # Load FASTA files
    try:
        genome_data.load_fasta(ref_fasta, target_fasta)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load FASTA: {e}")
    
    # Determine which transcript IDs to use for ref and target
    ref_id = request.transcript_id
    # target_id already determined above
    
    # Find transcript in reference (fast grep-based lookup)
    file_io.log_progress(f"Searching for transcript in reference GFF3 ({ref_id})...")
    
    # Try index first
    ref_tx = None
    ref_index = config.get("ref_index")
    if ref_index and os.path.exists(ref_index):
        ref_tx = gff_index.find_transcript_in_index(ref_index, ref_id)
        if ref_tx: file_io.log_progress("  ✓ Found in index")
        
    if not ref_tx:
        ref_tx = gff_index.find_transcript_fast(ref_gff, ref_id)
        
    if not ref_tx:
        raise HTTPException(
            status_code=404,
            detail=f"Transcript {ref_id} not found in reference"
        )
    
    # Find transcript in target
    file_io.log_progress(f"Searching for transcript in target GFF3 ({target_id})...")
    
    target_tx = None
    target_index = config.get("target_index")
    if target_index and os.path.exists(target_index):
        target_tx = gff_index.find_transcript_in_index(target_index, target_id)
        if target_tx: file_io.log_progress("  ✓ Found in index")
        
    if not target_tx:
        target_tx = gff_index.find_transcript_fast(target_gff, target_id)

    if not target_tx:
        raise HTTPException(
            status_code=404,
            detail=f"Transcript {target_id} not found in target (may be unmapped)"
        )
    
    # Calculate extraction regions (flanking values already calculated above)
    ref_start = max(1, ref_tx.start - ref_flank)
    ref_end = ref_tx.end + ref_flank
    ref_strand = ref_tx.strand
    
    target_start = max(1, target_tx.start - tgt_flank)
    target_end = target_tx.end + tgt_flank
    target_strand = target_tx.strand
    
    # Extract sequences
    file_io.log_progress(f"Extracting sequences (ref: {ref_flank}bp, target: {tgt_flank}bp flanking)...")
    try:
        ref_seq = extract_genomic_sequence(
            genome_data.ref_fasta, ref_tx.seq_region, ref_start, ref_end, ref_strand, uppercase=False
        )
        file_io.log_progress(f"  ✓ Reference: {len(ref_seq)}bp")
        target_seq = extract_genomic_sequence(
            genome_data.target_fasta, target_tx.seq_region, target_start, target_end, target_strand, uppercase=False
        )
        file_io.log_progress(f"  ✓ Target: {len(target_seq)}bp")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract sequences: {e}")
    
    # Run alignment
    try:
        ref_aligned, target_aligned = mafft.run_mafft_alignment(ref_seq, target_seq)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Alignment failed: {e}")
    
    # Map features
    ref_features = map_features_to_alignment(ref_tx, ref_start, ref_end, ref_aligned, ref_strand, ref_seq)
    target_features = map_features_to_alignment(target_tx, target_start, target_end, target_aligned, target_strand, target_seq)
    
    # Calculate stats
    identity, gaps = calculate_identity(ref_aligned, target_aligned)
    
    result = AlignmentResult(
        transcript_id=request.transcript_id,
        reference=AlignedRegion(
            name="reference",
            sequence=ref_aligned,
            features=ref_features,
            chrom=ref_tx.seq_region,
            genomic_start=ref_start,
            genomic_end=ref_end,
            strand=ref_strand
        ),
        target=AlignedRegion(
            name="target",
            sequence=target_aligned,
            features=target_features,
            chrom=target_tx.seq_region,
            genomic_start=target_start,
            genomic_end=target_end,
            strand=target_strand
        ),
        alignment_length=len(ref_aligned),
        identity=identity,
        gaps=gaps,
        timestamp=datetime.now().isoformat()
    )
    
    # Save to cache
    if output_dir and os.path.exists(output_dir):
        # Always construct a new, correctly-named cache file for this specific
        # flank combination.  Never reuse cache_path here: it may point to a
        # *larger* compatible cache that was found by find_compatible_cache,
        # and writing the smaller result there would corrupt it.
        safe_ref = ref_id.replace(":", "_").replace("/", "_")
        safe_tgt = target_id.replace(":", "_").replace("/", "_")
        filename = f"align_{safe_ref}_{safe_tgt}_{ref_flank}_{tgt_flank}.json"

        save_cache_dir = os.path.join(output_dir, "alignment_cache")
        os.makedirs(save_cache_dir, exist_ok=True)

        new_cache_path = os.path.join(save_cache_dir, filename)
        try:
            with open(new_cache_path, 'w') as f:
                f.write(result.model_dump_json())
            file_io.log_progress(f"  ✓ Saved alignment to cache: {Path(new_cache_path).name}")
        except Exception as e:
            logger.error(f"Failed to write cache: {e}")
            
    # Add to recent
    recent_transcripts.insert(0, RecentItem(
        transcript_id=request.transcript_id,
        target_transcript_id=request.target_transcript_id or "",
        timestamp=result.timestamp,
        identity=identity
    ))
    while len(recent_transcripts) > 20:
        recent_transcripts.pop()
            
    return result


_SHARED_ALIGNMENT_STORES: Dict[str, "transcript_msa.AlignmentStore"] = {}


def _shared_alignment_store(output_dir: Optional[str]) -> Optional["transcript_msa.AlignmentStore"]:
    """The alignments folder the Gene Trees view shares: ``local_data/alignments``."""
    root = str(output_dir or "").strip()
    if not root or not os.path.isdir(root):
        return None
    folder = _alignments_dir(root)
    if str(folder) not in _SHARED_ALIGNMENT_STORES:
        _SHARED_ALIGNMENT_STORES[str(folder)] = transcript_msa.AlignmentStore(folder)
    return _SHARED_ALIGNMENT_STORES[str(folder)]


def _msa_shared_rows(prepared_rows: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
    """Each MSA row as the shared store knows rows: key, region, signature. None if one has no assembly."""
    out = []
    for item in prepared_rows:
        try:
            species = genome_context._resolve_browse_genome_context(item["genome"]).get("species") or {}
        except Exception:
            return None
        assembly = str(species.get("assembly") or species.get("gca") or "").strip()
        if not assembly:
            return None
        tx = item["tx"]
        region = _tmsa_window_region(asdict(tx), int(item["window_start"]), int(item["window_end"]),
                                     int(item["flank_5_bp"]), int(item["flank_3_bp"]))
        region["chrom"] = str(item.get("fetched_chrom") or tx.seq_region or "")
        row_key = f"{assembly}:{item['transcript_id']}"
        input_hash = transcript_msa.sequence_hash(str(item["raw_seq"] or ""))
        structure = _tmsa_structure_hash(asdict(tx))
        out.append({"row_key": row_key, "assembly": assembly, "region": region, "input_hash": input_hash, "structure": structure,
                    "signature": transcript_msa.row_signature(row_key, _tmsa_params_of(region), input_hash, structure)})
    return out


def _msa_result_from_store(store, stem: str, prepared_rows, shared, requested_rows, excluded_rows, warnings, profile):
    """A stored alignment (the Gene Trees', say) holding every row asked for, cut down to them."""
    alignment = transcript_msa.project(store.load(stem), [r["row_key"] for r in shared])
    by_key = {r["row_key"]: r for r in alignment["rows"]}
    rows: List[MultiAlignedRow] = []
    for item, row_id in zip(prepared_rows, shared):
        row = by_key.get(row_id["row_key"])
        if not row:
            return None
        features = [Feature(**{k: f[k] for k in ("type", "start", "end", "original_start", "original_end")})
                    for f in row.get("features") or [] if f.get("type") != "intron_cut"] if item["overlay_annotation"] else []
        rows.append(MultiAlignedRow(
            genome=str(item["genome"] or ""), genome_key=str(item["genome_key"] or ""), tag=str(item["tag"] or ""),
            query=str(item["query"] or ""), transcript_id=str(item["transcript_id"] or ""),
            chrom=str(item.get("fetched_chrom") or item["tx"].seq_region or ""),
            genomic_start=int(item["window_start"]), genomic_end=int(item["window_end"]), strand=str(item["tx"].strand or "+"),
            aligned_sequence=row["aligned"], raw_length=len(str(item["raw_seq"] or "")),
            flank_5_bp=int(item["flank_5_bp"]), flank_3_bp=int(item["flank_3_bp"]),
            overlay_annotation=bool(item["overlay_annotation"]), use_gene_boundaries=bool(item.get("use_gene_boundaries", True)),
            features=features, identity_to_consensus=float(row.get("identity") or 0), gap_fraction=float(row.get("gap_fraction") or 0)))
    return MultiAlignmentResult(
        timestamp=datetime.now().isoformat(), alignment_length=int(alignment["alignment_length"]),
        requested_count=len(requested_rows), included_count=len(rows), profile=profile,
        strategy=str(alignment.get("strategy") or "stored"), consensus=alignment["consensus"],
        average_identity=float(alignment.get("average_identity") or 0),
        warnings=[*warnings, f"Reused a stored alignment ({alignment.get('name') or stem})."],
        rows=rows, excluded_rows=excluded_rows, cache_hit=True)


def _msa_save_shared(store, prepared_rows, shared, ordered_aligned_rows, strategy: str, consensus: str) -> None:
    """Keep an MSA run in the shared folder, so the Gene Trees view can reuse it (and this view, later)."""
    shared_by_item = {id(item): row_id for item, row_id in zip(prepared_rows, shared)}
    rows = []
    for item, aligned_seq in ordered_aligned_rows:
        row_id = shared_by_item.get(id(item))
        if row_id is None:
            return
        aligned = str(aligned_seq).upper()
        raw = str(item["raw_seq"] or "").upper()
        rows.append({**row_id, "genome_key": str(item["genome_key"] or ""), "tag": str(item["tag"] or ""),
                     "gene_id": str(item["query"] or ""), "gene_symbol": str(item["tag"] or ""),
                     "transcript_id": str(item["transcript_id"] or ""), "chrom": row_id["region"]["chrom"],
                     "strand": str(item["tx"].strand or "+"), "genomic_start": int(item["window_start"]),
                     "genomic_end": int(item["window_end"]), "flank_5_bp": int(item["flank_5_bp"]),
                     "flank_3_bp": int(item["flank_3_bp"]), "raw_length": len(raw),
                     "features": transcript_msa.map_features(asdict(item["tx"]), row_id["region"], aligned, raw),
                     "aligned": aligned})
    if len(rows) < 2:
        return
    summary = transcript_msa.project({"rows": rows, "alignment_length": len(rows[0]["aligned"])}, [r["row_key"] for r in rows])
    store.save({**summary, "params": _tmsa_params_of(rows[0]["region"]), "strategy": strategy},
               "msa " + " ".join(r["tag"] for r in rows)[:60], source="multi_alignment", auto=True)


def _trim_multi_to_transcripts(result: "MultiAlignmentResult", prepared_rows: List[Dict[str, Any]]) -> "MultiAlignmentResult":
    """Cut an alignment down to the selected transcripts, each with its row's flanks.

    With gene boundaries on, a row's window is its whole gene, which can run far past the
    transcript chosen (a longer transcript of the same gene, say) and stretch the alignment
    with sequence no selected transcript has. The columns kept run from the first to the last
    that any row's transcript (plus its flanks) reaches; each row's coordinates, features,
    identity and the consensus are worked out again for what is left.
    """
    rows = list(result.rows or [])
    length = int(result.alignment_length or 0)
    if not rows or length <= 0:
        return result
    items = {(str(i["genome_key"] or ""), str(i["transcript_id"] or "")): i for i in prepared_rows}
    first_col, last_col = None, None
    for row in rows:
        item = items.get((row.genome_key, row.transcript_id))
        if item is None:
            return result  # which transcript a row is cannot be told: leave the alignment whole
        tx = item["tx"]
        lo, hi = _interval_window_with_oriented_flanks(int(tx.start), int(tx.end), row.strand, row.flank_5_bp, row.flank_3_bp)
        lo, hi = max(lo, int(row.genomic_start)), min(hi, int(row.genomic_end))
        if hi < lo:
            continue
        if row.strand == "-":
            i0, i1 = int(row.genomic_end) - hi, int(row.genomic_end) - lo
        else:
            i0, i1 = lo - int(row.genomic_start), hi - int(row.genomic_start)
        columns = [c for c, ch in enumerate(row.aligned_sequence) if ch != "-"]
        if not columns:
            continue
        i0, i1 = max(0, i0), min(len(columns) - 1, i1)
        if i0 > i1:
            continue
        first_col = columns[i0] if first_col is None else min(first_col, columns[i0])
        last_col = columns[i1] if last_col is None else max(last_col, columns[i1])
    if first_col is None or (first_col == 0 and last_col == length - 1):
        return result

    trimmed_seqs = [row.aligned_sequence[first_col:last_col + 1] for row in rows]
    consensus = _build_consensus_from_aligned_rows(trimmed_seqs)
    new_rows = []
    for row, seq in zip(rows, trimmed_seqs):
        before = sum(1 for ch in row.aligned_sequence[:first_col] if ch != "-")
        kept = sum(1 for ch in seq if ch != "-")
        if row.strand == "-":
            end = int(row.genomic_end) - before
            start = end - kept + 1
        else:
            start = int(row.genomic_start) + before
            end = start + kept - 1
        features = []
        for f in row.features or []:
            fs, fe = max(int(f.start), first_col), min(int(f.end), last_col)
            if fs <= fe:
                features.append(f.model_copy(update={"start": fs - first_col, "end": fe - first_col}))
        new_rows.append(row.model_copy(update={
            "aligned_sequence": seq, "genomic_start": start, "genomic_end": end, "raw_length": kept, "features": features,
            "identity_to_consensus": _identity_to_consensus(seq, consensus), "gap_fraction": _gap_fraction(seq)}))
    left_out = length - (last_col - first_col + 1)
    return result.model_copy(update={
        "alignment_length": len(consensus), "consensus": consensus, "rows": new_rows,
        "average_identity": float(sum(r.identity_to_consensus for r in new_rows) / max(1, len(new_rows))),
        "warnings": [*(result.warnings or []), f"Trimmed to the selected transcripts and their flanks: {left_out:,} column{'' if left_out == 1 else 's'} of gene sequence beyond them left out."]})


@router.post("/api/align/multi", response_model=MultiAlignmentResult)
def align_multi(request: MultiAlignmentRequest):
    """Align several genomes at once.

    On a worker thread for the same reason as :func:`align_transcripts`, and more so:
    this one's cost scales with the number of genomes in the alignment.
    """
    if not request.rows:
        raise HTTPException(status_code=400, detail="At least one row is required.")

    config = config_store.load_config()
    settings = request.run_settings or MultiAlignmentRunSettings()
    requested_profile = mafft._normalize_multi_profile(settings.profile)
    profile = "balanced"
    divergence_mode = mafft._normalize_multi_divergence_mode(settings.divergence_mode)
    soft_warn = max(1, int(settings.soft_warn_sequences or 6))
    hard_cap = max(2, int(settings.hard_cap_sequences or 10))
    max_total_bp = max(1000, int(settings.max_total_bp or 500_000))
    timeout_sec = max(30, int(settings.timeout_sec or 300))

    requested_rows = list(request.rows or [])
    excluded_rows: List[MultiAlignmentExcludedRow] = []
    warnings: List[str] = []
    if requested_profile != "balanced":
        warnings.append("Alignment profile overridden to balanced for this view.")
    prepared_rows: List[Dict[str, Any]] = []

    for idx, row in enumerate(requested_rows):
        row_genome = str(row.genome or row.genome_key or "").strip()
        row_key = str(row.genome_key or row_genome or "").strip()
        row_tag = str(row.tag or f"G{idx + 1}").strip() or f"G{idx + 1}"
        row_query = str(row.query or "").strip()
        row_tx = str(row.selected_transcript_id or row.transcript_id or "").strip()
        include = bool(row.include)

        if not row_tx and row_query:
            row_tx = _resolve_transcript_id_for_genome_query(row_genome, row_query)

        if not include:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome or row_key,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Excluded by user",
            ))
            continue
        if not row_genome:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome or row_key,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Missing genome identifier",
            ))
            continue
        if not row_tx:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="No transcript selected",
            ))
            continue

        try:
            tx = _find_transcript_for_genome(row_genome, row_tx)
        except HTTPException as e:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason=str(e.detail or "Genome context not available"),
            ))
            continue
        except Exception:
            tx = None

        if tx is None:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Transcript not found for genome",
            ))
            continue

        try:
            fasta = genome_context._get_browse_fasta(row_genome)
        except HTTPException as e:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason=str(e.detail or "FASTA unavailable"),
            ))
            continue

        flank_5_bp = max(0, int(row.flank_5_bp or 0))
        flank_3_bp = max(0, int(row.flank_3_bp or 0))
        use_gene_boundaries = bool(row.use_gene_boundaries)
        if use_gene_boundaries:
            gene_start, gene_end = _find_parent_gene_boundaries(row_genome, row_tx)
            if gene_start is not None and gene_end is not None:
                window_start, window_end = _interval_window_with_oriented_flanks(
                    gene_start,
                    gene_end,
                    str(tx.strand or "+"),
                    flank_5_bp,
                    flank_3_bp,
                )
            else:
                window_start, window_end = _transcript_window_with_oriented_flanks(tx, flank_5_bp, flank_3_bp)
                warnings.append(f"{row_tag}: gene boundaries unavailable, used selected transcript boundaries instead.")
        else:
            window_start, window_end = _transcript_window_with_oriented_flanks(tx, flank_5_bp, flank_3_bp)

        try:
            raw_seq, fetched_chrom, fetched_start, fetched_end = _extract_sequence_for_alignment_row(
                row_genome,
                fasta,
                tx.seq_region,
                window_start,
                window_end,
                tx.strand,
            )
        except Exception as exc:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason=f"Failed to extract sequence: {exc}",
            ))
            continue

        if not raw_seq:
            excluded_rows.append(MultiAlignmentExcludedRow(
                genome=row_genome,
                genome_key=row_key,
                tag=row_tag,
                query=row_query,
                transcript_id=row_tx,
                reason="Extracted sequence is empty",
            ))
            continue

        prepared_rows.append({
            "genome": row_genome,
            "genome_key": row_key,
            "tag": row_tag,
            "query": row_query,
            "transcript_id": row_tx,
            "flank_5_bp": flank_5_bp,
            "flank_3_bp": flank_3_bp,
            "overlay_annotation": bool(row.overlay_annotation),
            "use_gene_boundaries": use_gene_boundaries,
            "tx": tx,
            "window_start": int(fetched_start),
            "window_end": int(fetched_end),
            "fetched_chrom": str(fetched_chrom),
            "raw_seq": raw_seq,
        })

    included_count = len(prepared_rows)
    if included_count < 2:
        return MultiAlignmentResult(
            timestamp=datetime.now().isoformat(),
            alignment_length=0,
            requested_count=len(requested_rows),
            included_count=included_count,
            profile=profile,
            strategy="none",
            consensus="",
            average_identity=0.0,
            warnings=["Need at least two resolved genomes to run alignment."],
            rows=[],
            excluded_rows=excluded_rows,
            cache_hit=False,
        )

    if included_count > hard_cap:
        raise HTTPException(
            status_code=400,
            detail=f"Requested {included_count} sequences exceeds hard cap ({hard_cap}). Increase cap in Alignment Advanced or include fewer genomes."
        )
    if included_count > soft_warn:
        warnings.append(f"Aligning {included_count} sequences may be slow on laptop hardware.")

    if excluded_rows:
        preview = ", ".join([
            f"{(r.tag or r.genome_key or r.genome)} ({r.reason})"
            for r in excluded_rows[:5]
        ])
        if len(excluded_rows) > 5:
            preview = f"{preview} +{len(excluded_rows) - 5} more"
        warnings.append(f"Excluded rows: {preview}")

    total_bp = sum(len(str(item["raw_seq"] or "")) for item in prepared_rows)
    max_len = max(len(str(item["raw_seq"] or "")) for item in prepared_rows)
    if total_bp > max_total_bp:
        raise HTTPException(
            status_code=400,
            detail=f"Total input size {total_bp}bp exceeds max_total_bp ({max_total_bp}). Increase limit or reduce flanking/genomes."
        )

    strategy, strategy_warnings, mafft_args = mafft._choose_msa_strategy(
        profile,
        included_count,
        max_len,
        total_bp,
        strict_balanced=True,
    )
    warnings.extend(strategy_warnings)
    if divergence_mode != "auto":
        warnings.append(f"Divergence display mode preference: {divergence_mode}")

    cache_dir = _multi_alignment_cache_dir(config.get("output_dir"))
    cache_hit = False
    cache_payload = {
        "profile": profile,
        "strategy": strategy,
        # Results are cut down to the selected transcripts (see _trim_multi_to_transcripts):
        # untrimmed ones cached before that are not reused.
        "trim": "selected_transcripts",
        "settings": {
            "soft_warn_sequences": soft_warn,
            "hard_cap_sequences": hard_cap,
            "max_total_bp": max_total_bp,
            "timeout_sec": timeout_sec,
            "divergence_mode": divergence_mode,
        },
        "rows": [
            {
                "genome": item["genome"],
                "genome_key": item["genome_key"],
                "tag": item["tag"],
                "transcript_id": item["transcript_id"],
                "flank_5_bp": item["flank_5_bp"],
                "flank_3_bp": item["flank_3_bp"],
                "overlay_annotation": item["overlay_annotation"],
                "use_gene_boundaries": item["use_gene_boundaries"],
                "raw_seq_hash": hashlib.md5(str(item["raw_seq"]).encode("utf-8")).hexdigest(),
            }
            for item in prepared_rows
        ],
    }
    cache_path: Optional[Path] = None
    if cache_dir:
        cache_key = _stable_json_hash(cache_payload)
        cache_path = cache_dir / f"{cache_key}.json"
        if cache_path.exists():
            try:
                with cache_path.open("r") as f:
                    data = json.load(f)
                cached = MultiAlignmentResult(**data)
                return cached.model_copy(update={"cache_hit": True})
            except Exception:
                cache_hit = False

    # An alignment another view (the Gene Trees') already made of exactly these rows.
    shared_store = _shared_alignment_store(config.get("output_dir"))
    shared_rows = None
    if shared_store is not None:
        try:
            shared_rows = _msa_shared_rows(prepared_rows)
            stem = shared_store.find_covering([r["signature"] for r in shared_rows]) if shared_rows else None
            reused = _msa_result_from_store(shared_store, stem, prepared_rows, shared_rows, requested_rows,
                                            excluded_rows, warnings, profile) if stem else None
            if reused is not None:
                return _trim_multi_to_transcripts(reused, prepared_rows)
        except Exception:
            logger.warning("Could not look in the shared alignments folder", exc_info=True)

    ordered_sequences: List[Tuple[str, str]] = []
    seq_id_to_row: Dict[str, Dict[str, Any]] = {}
    for idx, item in enumerate(prepared_rows):
        seq_id = f"row{idx + 1}_{re.sub(r'[^A-Za-z0-9_.-]', '_', str(item['tag']))}"
        ordered_sequences.append((seq_id, str(item["raw_seq"])))
        seq_id_to_row[seq_id] = item

    started = time.time()
    try:
        aligned_map = mafft.run_mafft_alignment_multi(ordered_sequences, mafft_args, timeout_sec=timeout_sec)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MSA failed: {e}")
    elapsed = time.time() - started
    warnings.append(f"MSA completed in {elapsed:.1f}s using {strategy} strategy.")

    ordered_aligned_rows: List[Tuple[Dict[str, Any], str]] = []
    for seq_id, _ in ordered_sequences:
        aligned_seq = str(aligned_map.get(seq_id) or "")
        if not aligned_seq:
            continue
        ordered_aligned_rows.append((seq_id_to_row[seq_id], aligned_seq))

    if len(ordered_aligned_rows) < 2:
        raise HTTPException(status_code=500, detail="MSA returned fewer than two aligned sequences.")

    aligned_seqs = [aligned_seq for _, aligned_seq in ordered_aligned_rows]
    consensus = _build_consensus_from_aligned_rows(aligned_seqs)
    alignment_length = len(consensus)

    row_results: List[MultiAlignedRow] = []
    identity_values: List[float] = []
    for item, aligned_seq in ordered_aligned_rows:
        features: List[Feature] = []
        if bool(item["overlay_annotation"]):
            try:
                features = map_features_to_alignment(
                    item["tx"],
                    int(item["window_start"]),
                    int(item["window_end"]),
                    aligned_seq,
                    str(item["tx"].strand or "+"),
                    str(item["raw_seq"] or ""),
                )
            except Exception:
                features = []
        ident = _identity_to_consensus(aligned_seq, consensus)
        gap_frac = _gap_fraction(aligned_seq)
        identity_values.append(ident)
        row_results.append(MultiAlignedRow(
            genome=str(item["genome"] or ""),
            genome_key=str(item["genome_key"] or ""),
            tag=str(item["tag"] or ""),
            query=str(item["query"] or ""),
            transcript_id=str(item["transcript_id"] or ""),
            # Preserve feature mapping from transcript model, but report
            # the effective chromosome used for sequence extraction when aliased.
            chrom=str(item.get("fetched_chrom") or item["tx"].seq_region or ""),
            genomic_start=int(item["window_start"]),
            genomic_end=int(item["window_end"]),
            strand=str(item["tx"].strand or "+"),
            aligned_sequence=aligned_seq,
            raw_length=len(str(item["raw_seq"] or "")),
            flank_5_bp=int(item["flank_5_bp"]),
            flank_3_bp=int(item["flank_3_bp"]),
            overlay_annotation=bool(item["overlay_annotation"]),
            use_gene_boundaries=bool(item.get("use_gene_boundaries", True)),
            features=features,
            identity_to_consensus=ident,
            gap_fraction=gap_frac,
        ))

    avg_identity = float(sum(identity_values) / max(1, len(identity_values)))
    result = MultiAlignmentResult(
        timestamp=datetime.now().isoformat(),
        alignment_length=alignment_length,
        requested_count=len(requested_rows),
        included_count=len(row_results),
        profile=profile,
        strategy=strategy,
        consensus=consensus,
        average_identity=avg_identity,
        warnings=warnings,
        rows=row_results,
        excluded_rows=excluded_rows,
        cache_hit=cache_hit,
    )
    result = _trim_multi_to_transcripts(result, prepared_rows)

    if cache_path:
        try:
            with cache_path.open("w") as f:
                json.dump(result.model_dump(), f)
        except Exception:
            pass
    if shared_store is not None and shared_rows:
        try:
            _msa_save_shared(shared_store, prepared_rows, shared_rows, ordered_aligned_rows, strategy, consensus)
        except Exception:
            logger.warning("Could not keep the alignment in the shared folder", exc_info=True)

    return result


@router.get("/api/align/check")
def check_alignment_status(
    transcript_id: str, 
    ref_flank: int, 
    tgt_flank: int,
    target_transcript_id: Optional[str] = None
):
    """Check if a compatible alignment exists in cache."""
    config = config_store.load_config()
    output_dir = config.get("output_dir")
    
    tgt_id = target_transcript_id or transcript_id
    
    path, _, _ = find_compatible_cache(output_dir, transcript_id, tgt_id, ref_flank, tgt_flank)
    
    if path:
        return {"status": "found", "type": "Load alignment"}
    else:
        return {"status": "missing", "type": "Run alignment"}


# ── Saved-alignment persistence ────────────────────────────────────────────────

def _alignments_dir(output_dir: str) -> Path:
    """Returns the directory used to persist named alignment files."""
    return Path(output_dir).expanduser().resolve() / "local_data" / "alignments"


def _safe_alignment_name(name: str) -> str:
    """Sanitise alignment name: keep alphanumerics, hyphens, underscores, dots."""
    import re as _re
    cleaned = _re.sub(r"[^\w\-.]", "_", name.strip())
    return cleaned[:200] or "alignment"


class AlignmentSaveGenomeInfo(BaseModel):
    genome_key: str
    species_key: str = ""
    assembly: str = ""
    assembly_name: str = ""
    scientific_name: str = ""
    common_name: str = ""
    gene_symbol: str = ""
    gene_id: str = ""
    transcript_id: str = ""
    tag: str = ""
    chrom: str = ""
    genomic_start: int = 0
    genomic_end: int = 0
    strand: str = "+"
    raw_length: int = 0
    flank_5_bp: int = 0
    flank_3_bp: int = 0
    use_gene_boundaries: bool = True
    identity_to_consensus: float = 0.0
    gap_fraction: float = 0.0
    features: List[Any] = []


class SaveAlignmentRequest(BaseModel):
    name: str
    output_dir: str
    genomes: List[AlignmentSaveGenomeInfo]
    aligned_sequences: Dict[str, str]   # genome_key → gapped aligned sequence
    stats: Dict[str, Any] = {}
    consensus: str = ""


class LoadAlignmentRequest(BaseModel):
    name: str
    output_dir: str
    genome_keys: List[str]              # which genomes to reconstruct


@router.post("/api/alignments/save")
def save_alignment(payload: SaveAlignmentRequest):
    """Persist a multi-alignment to local_data/alignments/ as a FASTA + JSON pair."""
    if not payload.output_dir or not os.path.exists(payload.output_dir):
        raise HTTPException(status_code=400, detail="output_dir is not set or does not exist")

    name = _safe_alignment_name(payload.name)
    aln_dir = _alignments_dir(payload.output_dir)
    try:
        aln_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot create alignments directory: {exc}")

    fasta_path = aln_dir / f"{name}.fasta"
    meta_path  = aln_dir / f"{name}.json"

    # Write FASTA (gapped aligned sequences)
    try:
        with open(fasta_path, "w") as fh:
            for genome in payload.genomes:
                seq = payload.aligned_sequences.get(genome.genome_key, "")
                if seq:
                    fh.write(f">{genome.genome_key}\n")
                    # Wrap at 60 chars
                    for i in range(0, len(seq), 60):
                        fh.write(seq[i:i+60] + "\n")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot write FASTA: {exc}")

    # Write JSON metadata
    meta = {
        "version": "1",
        "name": name,
        "created": datetime.utcnow().isoformat() + "Z",
        "fasta_file": fasta_path.name,
        "stats": payload.stats,
        "consensus": payload.consensus,
        "genomes": [g.model_dump() for g in payload.genomes],
    }
    try:
        with open(meta_path, "w") as fh:
            json.dump(meta, fh, indent=2)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot write metadata: {exc}")

    return {
        "status": "ok",
        "name": name,
        "fasta_path": str(fasta_path),
        "meta_path": str(meta_path),
    }


@router.get("/api/alignments/list")
def list_alignments(output_dir: str = ""):
    """List saved alignments in local_data/alignments/, newest first."""
    if not output_dir or not os.path.exists(output_dir):
        return {"alignments": []}

    aln_dir = _alignments_dir(output_dir)
    if not aln_dir.exists():
        return {"alignments": []}

    results = []
    for meta_file in sorted(aln_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with open(meta_file) as fh:
                meta = json.load(fh)
            if meta.get("auto"):
                continue  # kept by the views as a cache, not saved by the user
            # Return all fields except the per-genome features arrays (too large)
            slim_genomes = []
            for g in meta.get("genomes", []):
                entry = {k: v for k, v in g.items() if k != "features"}
                slim_genomes.append(entry)
            results.append({
                **{k: v for k, v in meta.items() if k not in ("genomes", "consensus")},
                "genomes": slim_genomes,
                "genome_keys": [g.get("genome_key", "") for g in slim_genomes],
                "file_stem": meta_file.stem,
            })
        except Exception:
            pass  # Skip corrupt files

    return {"alignments": results}


@router.post("/api/alignments/load")
def load_alignment(payload: LoadAlignmentRequest):
    """Reconstruct a MultiAlignmentResult from a saved alignment, filtered to genome_keys.

    On a worker thread: rebuilding a stored alignment is blocking work, and a large
    one is not quick.
    """
    if not payload.output_dir or not os.path.exists(payload.output_dir):
        raise HTTPException(status_code=400, detail="output_dir is not set or does not exist")

    name = _safe_alignment_name(payload.name)
    aln_dir = _alignments_dir(payload.output_dir)
    meta_path  = aln_dir / f"{name}.json"
    fasta_path = aln_dir / f"{name}.fasta"

    if not meta_path.exists():
        raise HTTPException(status_code=404, detail=f"Alignment '{name}' not found")

    try:
        with open(meta_path) as fh:
            meta = json.load(fh)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read metadata: {exc}")

    # Parse FASTA → {genome_key: aligned_sequence}
    sequences: Dict[str, str] = {}
    if fasta_path.exists():
        try:
            current_key = None
            buf: List[str] = []
            with open(fasta_path) as fh:
                for line in fh:
                    line = line.rstrip("\n")
                    if line.startswith(">"):
                        if current_key is not None:
                            sequences[current_key] = "".join(buf)
                        current_key = line[1:].strip()
                        buf = []
                    else:
                        buf.append(line)
            if current_key is not None:
                sequences[current_key] = "".join(buf)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Cannot read FASTA: {exc}")

    all_genome_meta = {g["genome_key"]: g for g in meta.get("genomes", [])}

    # Filter to requested genomes that exist in the file
    selected_keys = [k for k in payload.genome_keys if k in all_genome_meta and k in sequences]
    excluded_count = len(all_genome_meta) - len(selected_keys)

    if len(selected_keys) < 2:
        raise HTTPException(
            status_code=400,
            detail=f"Need at least 2 genomes; only {len(selected_keys)} found in file for the requested set."
        )

    # Recalculate consensus and stats for the selected subset
    selected_seqs = [sequences[k] for k in selected_keys]
    consensus = _build_consensus_from_aligned_rows(selected_seqs)

    rows_out = []
    for k in selected_keys:
        gm = all_genome_meta[k]
        seq = sequences[k]
        identity = _identity_to_consensus(seq, consensus)
        gap_frac  = _gap_fraction(seq)
        rows_out.append({
            "genome": gm.get("genome_key", k),
            "genome_key": gm.get("genome_key", k),
            "tag": gm.get("tag", ""),
            "query": gm.get("gene_symbol") or gm.get("gene_id") or gm.get("transcript_id", ""),
            "transcript_id": gm.get("transcript_id", ""),
            "chrom": gm.get("chrom", ""),
            "genomic_start": gm.get("genomic_start", 0),
            "genomic_end": gm.get("genomic_end", 0),
            "strand": gm.get("strand", "+"),
            "aligned_sequence": seq,
            "raw_length": gm.get("raw_length", 0),
            "flank_5_bp": gm.get("flank_5_bp", 0),
            "flank_3_bp": gm.get("flank_3_bp", 0),
            "use_gene_boundaries": gm.get("use_gene_boundaries", True),
            "overlay_annotation": True,
            "features": gm.get("features", []),
            "identity_to_consensus": round(identity, 4),
            "gap_fraction": round(gap_frac, 6),
        })

    avg_identity = (
        sum(r["identity_to_consensus"] for r in rows_out) / len(rows_out)
        if rows_out else 0.0
    )
    saved_stats = meta.get("stats", {})
    aln_len = len(selected_seqs[0]) if selected_seqs else 0

    result = {
        "timestamp": meta.get("created", datetime.utcnow().isoformat() + "Z"),
        "alignment_length": aln_len,
        "requested_count": len(payload.genome_keys),
        "included_count": len(rows_out),
        "profile": saved_stats.get("profile", "balanced"),
        "strategy": saved_stats.get("strategy", "loaded"),
        "consensus": consensus,
        "average_identity": round(avg_identity, 4),
        "warnings": [],
        "rows": rows_out,
        "excluded_rows": [],
        "cache_hit": False,
        "loaded_from_file": name,
        "excluded_count": excluded_count,
    }
    return result


@router.get("/api/recent", response_model=List[RecentItem])
async def get_recent():
    return recent_transcripts


@router.post("/api/recent/clear")
async def clear_recent():
    """Clear the recent transcripts history."""
    recent_transcripts.clear()
    return {"status": "ok", "message": "Recent transcripts cleared"}
