"""Genomic windows of sequence: normalising interval lists, building spliced/unspliced
segments for a transcript in 5' to 3' order, extracting oriented window sequence from
FASTA, and projecting features into window slices. Shared by the Feature Explorer, the
sequence view and splice tracks.
"""

from typing import Any, Dict, List, Optional, Tuple

from Bio.Seq import Seq
from pydantic import BaseModel


class FeatureSlice(BaseModel):
    type: str
    start: int  # 1-based, inclusive, relative to returned window
    end: int    # 1-based, inclusive, relative to returned window
    coord_start: Optional[int] = None  # absolute coord in selected sequence space
    coord_end: Optional[int] = None    # absolute coord in selected sequence space
    genomic_start: Optional[int] = None
    genomic_end: Optional[int] = None


def _normalize_interval_list(raw_features: Any, default_type: str, default_strand: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for item in (raw_features or []):
        if not isinstance(item, dict):
            continue
        start = int(item.get("start", 0) or 0)
        end = int(item.get("end", 0) or 0)
        if start <= 0 or end <= 0:
            continue
        if end < start:
            start, end = end, start
        ftype = str(item.get("feature_type") or default_type or "").strip() or default_type
        strand = str(item.get("strand") or default_strand or "+").strip() or "+"
        normalized = {
            "start": start,
            "end": end,
            "feature_type": ftype,
            "strand": strand,
        }
        raw_phase = item.get("phase")
        if raw_phase not in (None, "", "."):
            try:
                phase_value = int(raw_phase)
            except Exception:
                phase_value = None
            if phase_value in (0, 1, 2):
                normalized["phase"] = phase_value
        out.append(normalized)
    out.sort(key=lambda x: (x["start"], x["end"]))
    return out


def _ordered_five_to_three(intervals: List[Dict[str, Any]], strand: str) -> List[Dict[str, Any]]:
    ordered = sorted(intervals, key=lambda x: (x["start"], x["end"]))
    if strand == "-":
        ordered.reverse()
    return ordered


def _build_mode_segments(
    tx_start: int,
    tx_end: int,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    sequence_type: str,
) -> Tuple[int, int, List[Dict[str, int]], str]:
    """
    Returns (coord_min, coord_max, segments, status)
    status: ok | no_cds | error
    segments are in 5'->3' order with fields:
      coord_start, coord_end, genomic_start, genomic_end
    """
    if sequence_type == "genomic":
        start = min(tx_start, tx_end)
        end = max(tx_start, tx_end)
        if end < start or start <= 0:
            return 1, 1, [], "error"
        return start, end, [{
            "coord_start": start,
            "coord_end": end,
            "genomic_start": start,
            "genomic_end": end,
        }], "ok"

    source = exons if sequence_type == "transcript" else cds_list
    if sequence_type == "cds" and len(source) == 0:
        return 1, 1, [], "no_cds"
    if len(source) == 0:
        return 1, 1, [], "error"

    ordered = _ordered_five_to_three(source, strand)
    cursor = 1
    segments: List[Dict[str, int]] = []
    for seg in ordered:
        g_start = int(seg["start"])
        g_end = int(seg["end"])
        seg_len = (g_end - g_start) + 1
        if seg_len <= 0:
            continue
        segment = {
            "coord_start": cursor,
            "coord_end": cursor + seg_len - 1,
            "genomic_start": g_start,
            "genomic_end": g_end,
        }
        if sequence_type == "cds":
            raw_phase = seg.get("phase")
            if raw_phase in (0, 1, 2):
                segment["phase"] = int(raw_phase)
        segments.append(segment)
        cursor += seg_len

    if len(segments) == 0:
        return 1, 1, [], "error"
    return 1, segments[-1]["coord_end"], segments, "ok"


def _fetch_oriented_piece(fasta, chrom: str, genomic_start: int, genomic_end: int, strand: str) -> str:
    lo = min(genomic_start, genomic_end)
    hi = max(genomic_start, genomic_end)
    if lo <= 0 or hi < lo:
        return ""
    try:
        seq = str(fasta.fetch(chrom, lo - 1, hi)).upper()
    except Exception:
        return ""
    if strand == "-":
        return str(Seq(seq).reverse_complement()).upper()
    return seq


def _extract_window_sequence_from_segments(
    fasta,
    chrom: str,
    strand: str,
    segments: List[Dict[str, int]],
    coord_min: int,
    coord_max: int,
    window_start: int,
    window_end: int,
    placeholder: str = "-",
) -> str:
    length = max(0, (window_end - window_start) + 1)
    if length <= 0:
        return ""
    out = [placeholder] * length
    if coord_max < coord_min or len(segments) == 0:
        return "".join(out)

    effective_start = max(window_start, coord_min)
    effective_end = min(window_end, coord_max)
    if effective_end < effective_start:
        return "".join(out)

    for seg in segments:
        c_start = int(seg["coord_start"])
        c_end = int(seg["coord_end"])
        if c_end < effective_start or c_start > effective_end:
            continue
        ov_start = max(c_start, effective_start)
        ov_end = min(c_end, effective_end)
        if ov_end < ov_start:
            continue

        g_lo = min(int(seg["genomic_start"]), int(seg["genomic_end"]))
        g_hi = max(int(seg["genomic_start"]), int(seg["genomic_end"]))
        # Offset is measured in 5'->3' order within this segment.
        offset_start = ov_start - c_start
        offset_end = ov_end - c_start

        if strand == "+":
            piece_g_start = g_lo + offset_start
            piece_g_end = g_lo + offset_end
        else:
            piece_g_start = g_hi - offset_end
            piece_g_end = g_hi - offset_start

        piece = _fetch_oriented_piece(fasta, chrom, piece_g_start, piece_g_end, strand)
        if not piece:
            continue
        dst = ov_start - window_start
        for i, base in enumerate(piece):
            idx = dst + i
            if 0 <= idx < length:
                out[idx] = base

    return "".join(out)


def _extract_genomic_window_sequence(
    fasta,
    chrom: str,
    strand: str,
    tx_start: int,
    tx_end: int,
    window_start: int,
    window_end: int,
    placeholder: str = "-",
) -> str:
    length = max(0, (window_end - window_start) + 1)
    if length <= 0:
        return ""
    out = [placeholder] * length
    try:
        chrom_len = int(fasta.get_reference_length(chrom))
    except Exception:
        chrom_len = 0
    if chrom_len <= 0:
        return "".join(out)

    ov_start = max(1, window_start)
    ov_end = min(window_end, chrom_len)
    if ov_end < ov_start:
        return "".join(out)

    piece = _fetch_oriented_piece(fasta, chrom, ov_start, ov_end, strand)
    if not piece:
        return "".join(out)
    if strand == "+":
        dst_start = ov_start - window_start
    else:
        # In 5'->3' display for '-' strand, leftmost base corresponds to window_end.
        dst_start = window_end - ov_end

    for i, base in enumerate(piece):
        idx = dst_start + i
        if 0 <= idx < length:
            out[idx] = base
    return "".join(out)


def _oriented_coords_for_interval(start: int, end: int, strand: str) -> List[int]:
    lo = min(int(start), int(end))
    hi = max(int(start), int(end))
    if hi < lo:
        return []
    if strand == "-":
        return list(range(hi, lo - 1, -1))
    return list(range(lo, hi + 1))


def _group_coords_to_intervals(coords: List[int]) -> List[Tuple[int, int]]:
    if len(coords) == 0:
        return []
    grouped: List[Tuple[int, int]] = []
    run = [int(coords[0])]
    for coord in coords[1:]:
        c = int(coord)
        prev = int(run[-1])
        if abs(c - prev) == 1:
            run.append(c)
            continue
        grouped.append((min(run), max(run)))
        run = [c]
    grouped.append((min(run), max(run)))
    return grouped


def _oriented_sequence_from_coords(fasta, chrom: str, coords: List[int], strand: str) -> str:
    if len(coords) == 0:
        return ""
    out: List[str] = []
    for coord in coords:
        c = int(coord)
        if c <= 0:
            return ""
        try:
            base = str(fasta.fetch(chrom, c - 1, c)).upper()
        except Exception:
            return ""
        if len(base) != 1:
            return ""
        if strand == "-":
            out.append(str(Seq(base).reverse_complement()).upper())
        else:
            out.append(base)
    return "".join(out)


def _build_tx_feature_intervals(
    fasta,
    chrom: str,
    strand: str,
    exons: List[Dict[str, Any]],
    cds_list: List[Dict[str, Any]],
    utrs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    feats: List[Dict[str, Any]] = []

    # Exons and introns
    for exon in exons:
        feats.append({"type": "exon", "start": int(exon["start"]), "end": int(exon["end"])})

    exons_genomic = sorted(exons, key=lambda x: (x["start"], x["end"]))
    for i in range(len(exons_genomic) - 1):
        intron_start = int(exons_genomic[i]["end"]) + 1
        intron_end = int(exons_genomic[i + 1]["start"]) - 1
        if intron_end >= intron_start:
            feats.append({"type": "intron", "start": intron_start, "end": intron_end})

    # CDS and UTRs
    for cds in cds_list:
        feats.append({"type": "cds", "start": int(cds["start"]), "end": int(cds["end"])})

    for utr in utrs:
        ftype = str(utr.get("feature_type", "")).lower()
        if "five" in ftype or "5_prime" in ftype:
            out_type = "utr5"
        elif "three" in ftype or "3_prime" in ftype:
            out_type = "utr3"
        else:
            out_type = "utr3"
        feats.append({"type": out_type, "start": int(utr["start"]), "end": int(utr["end"])})

    # Start / stop codons from CDS boundaries, only when canonical codons are present.
    bio_cds = _ordered_five_to_three(cds_list, strand)
    cds_coords: List[int] = []
    for cds_seg in bio_cds:
        cds_coords.extend(_oriented_coords_for_interval(int(cds_seg["start"]), int(cds_seg["end"]), strand))

    if len(cds_coords) >= 3:
        start_coords = cds_coords[:3]
        stop_coords = cds_coords[-3:]

        start_seq = _oriented_sequence_from_coords(fasta, chrom, start_coords, strand)
        stop_seq = _oriented_sequence_from_coords(fasta, chrom, stop_coords, strand)

        if start_seq == "ATG":
            for codon_start, codon_end in _group_coords_to_intervals(start_coords):
                feats.append({"type": "start_codon", "start": codon_start, "end": codon_end})
        if stop_seq in {"TAA", "TAG", "TGA"}:
            for codon_start, codon_end in _group_coords_to_intervals(stop_coords):
                feats.append({"type": "stop_codon", "start": codon_start, "end": codon_end})

    # Canonical splice donor/acceptor checks around exon boundaries (GT/AG only).
    bio_exons = _ordered_five_to_three(exons, strand)
    for i in range(len(bio_exons) - 1):
        curr = bio_exons[i]
        nxt = bio_exons[i + 1]
        c_start = int(curr["start"])
        c_end = int(curr["end"])
        n_start = int(nxt["start"])
        n_end = int(nxt["end"])

        if strand == "+":
            d_start, d_end = c_end + 1, c_end + 2
            a_start, a_end = n_start - 2, n_start - 1
        else:
            d_start, d_end = c_start - 2, c_start - 1
            a_start, a_end = n_end + 1, n_end + 2

        donor_motif = _fetch_oriented_piece(fasta, chrom, d_start, d_end, strand)
        if donor_motif == "GT":
            feats.append({"type": "donor", "start": min(d_start, d_end), "end": max(d_start, d_end)})

        acceptor_motif = _fetch_oriented_piece(fasta, chrom, a_start, a_end, strand)
        if acceptor_motif == "AG":
            feats.append({"type": "acceptor", "start": min(a_start, a_end), "end": max(a_start, a_end)})

    return feats


def _project_feature_to_window_slices(
    ftype: str,
    g_start: int,
    g_end: int,
    sequence_type: str,
    strand: str,
    segments: List[Dict[str, int]],
    window_start: int,
    window_end: int,
) -> List[Dict[str, int]]:
    slices: List[Dict[str, int]] = []
    if window_end < window_start:
        return slices

    if sequence_type == "genomic":
        ov_start = max(g_start, window_start)
        ov_end = min(g_end, window_end)
        if ov_end < ov_start:
            return slices
        if strand == "-":
            rel_start = (window_end - ov_end) + 1
            rel_end = (window_end - ov_start) + 1
        else:
            rel_start = (ov_start - window_start) + 1
            rel_end = (ov_end - window_start) + 1
        slices.append({
            "type": ftype,
            "start": min(rel_start, rel_end),
            "end": max(rel_start, rel_end),
            "coord_start": ov_start,
            "coord_end": ov_end,
            "genomic_start": ov_start,
            "genomic_end": ov_end,
        })
        return slices

    for seg in segments:
        seg_g_lo = min(int(seg["genomic_start"]), int(seg["genomic_end"]))
        seg_g_hi = max(int(seg["genomic_start"]), int(seg["genomic_end"]))
        ov_start = max(seg_g_lo, g_start)
        ov_end = min(seg_g_hi, g_end)
        if ov_end < ov_start:
            continue

        c_start = int(seg["coord_start"])
        if strand == "+":
            proj_start = c_start + (ov_start - seg_g_lo)
            proj_end = c_start + (ov_end - seg_g_lo)
        else:
            proj_start = c_start + (seg_g_hi - ov_end)
            proj_end = c_start + (seg_g_hi - ov_start)
        coord_start = min(proj_start, proj_end)
        coord_end = max(proj_start, proj_end)

        clip_start = max(coord_start, window_start)
        clip_end = min(coord_end, window_end)
        if clip_end < clip_start:
            continue
        rel_start = (clip_start - window_start) + 1
        rel_end = (clip_end - window_start) + 1
        if strand == "+":
            g_clip_start = seg_g_lo + (clip_start - c_start)
            g_clip_end = seg_g_lo + (clip_end - c_start)
        else:
            g_clip_start = seg_g_hi - (clip_end - c_start)
            g_clip_end = seg_g_hi - (clip_start - c_start)
        slices.append({
            "type": ftype,
            "start": rel_start,
            "end": rel_end,
            "coord_start": clip_start,
            "coord_end": clip_end,
            "genomic_start": min(g_clip_start, g_clip_end),
            "genomic_end": max(g_clip_start, g_clip_end),
        })

    return slices


def _merge_feature_slices(slices: List[Dict[str, int]]) -> List[FeatureSlice]:
    if len(slices) == 0:
        return []
    grouped: Dict[str, List[Dict[str, int]]] = {}
    for slc in slices:
        ftype = str(slc.get("type", "")).strip()
        start = int(slc.get("start", 0) or 0)
        end = int(slc.get("end", 0) or 0)
        if not ftype or start <= 0 or end <= 0:
            continue
        if end < start:
            start, end = end, start
        coord_start = int(slc.get("coord_start", 0) or 0)
        coord_end = int(slc.get("coord_end", 0) or 0)
        if coord_start > 0 and coord_end > 0 and coord_end < coord_start:
            coord_start, coord_end = coord_end, coord_start
        genomic_start = int(slc.get("genomic_start", 0) or 0)
        genomic_end = int(slc.get("genomic_end", 0) or 0)
        if genomic_start > 0 and genomic_end > 0 and genomic_end < genomic_start:
            genomic_start, genomic_end = genomic_end, genomic_start
        grouped.setdefault(ftype, []).append({
            "start": start,
            "end": end,
            "coord_start": coord_start,
            "coord_end": coord_end,
            "genomic_start": genomic_start,
            "genomic_end": genomic_end,
        })

    merged_out: List[FeatureSlice] = []
    for ftype, ranges in grouped.items():
        ranges.sort(key=lambda x: (x["start"], x["end"]))
        cur = dict(ranges[0])
        for item in ranges[1:]:
            can_merge_display = item["start"] <= (cur["end"] + 1)
            can_merge_coord = (
                cur["coord_start"] > 0 and cur["coord_end"] > 0
                and item["coord_start"] > 0 and item["coord_end"] > 0
                and item["coord_start"] <= (cur["coord_end"] + 1)
            )
            can_merge_genomic = (
                cur["genomic_start"] > 0 and cur["genomic_end"] > 0
                and item["genomic_start"] > 0 and item["genomic_end"] > 0
                and item["genomic_start"] <= (cur["genomic_end"] + 1)
            )
            if can_merge_display and can_merge_coord and can_merge_genomic:
                cur["end"] = max(cur["end"], item["end"])
                cur["coord_start"] = min(cur["coord_start"], item["coord_start"])
                cur["coord_end"] = max(cur["coord_end"], item["coord_end"])
                cur["genomic_start"] = min(cur["genomic_start"], item["genomic_start"])
                cur["genomic_end"] = max(cur["genomic_end"], item["genomic_end"])
            else:
                merged_out.append(FeatureSlice(
                    type=ftype,
                    start=cur["start"],
                    end=cur["end"],
                    coord_start=cur["coord_start"] or None,
                    coord_end=cur["coord_end"] or None,
                    genomic_start=cur["genomic_start"] or None,
                    genomic_end=cur["genomic_end"] or None,
                ))
                cur = dict(item)
        merged_out.append(FeatureSlice(
            type=ftype,
            start=cur["start"],
            end=cur["end"],
            coord_start=cur["coord_start"] or None,
            coord_end=cur["coord_end"] or None,
            genomic_start=cur["genomic_start"] or None,
            genomic_end=cur["genomic_end"] or None,
        ))
    merged_out.sort(key=lambda x: (x.start, x.end, x.type))
    return merged_out
