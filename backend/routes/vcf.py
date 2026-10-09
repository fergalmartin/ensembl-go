"""VCF tracks: shared per-file VCF handles with per-path locks, consequence/effect
grouping, gene-context classification, summary/detail/block tiles with their on-disk
tile caches, and the /api/browse/vcf endpoints.
"""

import hashlib
import json
import logging
import math
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import pysam
from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import app_paths
import genome_context

logger = logging.getLogger(__name__)
router = APIRouter()


# ── VCF endpoint ─────────────────────────────────────────────────────────────

_VCF_EFFECT_GROUPS = (
    "protein_altering",
    "splicing",
    "transcript",
    "regulatory",
    "intergenic",
    "other",
)


_VCF_PROTEIN_TERMS = {
    "missense_variant", "stop_gained", "stop_lost", "start_lost",
    "frameshift_variant", "inframe_insertion", "inframe_deletion",
    "protein_altering_variant", "coding_sequence_variant",
}


_VCF_SPLICING_TERMS = {
    "splice_acceptor_variant", "splice_donor_variant", "splice_region_variant",
    "splice_donor_5th_base_variant", "splice_polypyrimidine_tract_variant",
}


_VCF_REGULATORY_TERMS = {
    "regulatory_region_variant", "tf_binding_site_variant",
    "regulatory_region_amplification", "regulatory_region_ablation",
}


_VCF_INTERGENIC_TERMS = {
    "intergenic_variant", "upstream_gene_variant", "downstream_gene_variant",
}


_VCF_TRANSCRIPT_TERMS = {
    "transcript_variant", "synonymous_variant", "intron_variant",
    "non_coding_transcript_variant", "5_prime_utr_variant", "3_prime_utr_variant",
    "nmd_transcript_variant", "mature_mirna_variant", "coding_transcript_variant",
}


_VCF_HANDLE_CACHE: Dict[str, Dict[str, Any]] = {}


_VCF_HANDLE_CACHE_GUARD = threading.Lock()


_VCF_HANDLE_LOCKS: Dict[str, threading.Lock] = {}


_VCF_HANDLE_LOCKS_GUARD = threading.Lock()


_VCF_TILE_DISK_CACHE_DIR = app_paths.CACHE_DIR / "vcf_tiles"


_VCF_TILE_CACHE_SCHEMA = "v6"


class VcfCoverageSpan(BaseModel):
    start: int
    end: int
    class_name: str  # intergenic | transcript
    coverage_fraction: float


class VcfTileRequest(BaseModel):
    start: int
    end: int
    lod: str = "L2"
    mode: str = "summary"  # summary | detail
    bins: int = 512
    max_variants: int = 3000
    block_window_bp: Optional[int] = None
    block_stride_bp: Optional[int] = None
    block_coverage_threshold: Optional[float] = 0.5
    block_mode: Optional[str] = "coverage_spans"


class VcfTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[VcfTileRequest]
    include_effects: bool = True
    genome: Optional[str] = None


# ── New block-tile endpoint models ──────────────────────────────────────────

VCF_BLOCK_DENSITY_BIN_BP = 100


_VCF_BLOCK_TILE_CACHE_SCHEMA = "v5"


_VCF_BLOCK_TILE_DISK_CACHE_DIR = app_paths.CACHE_DIR / "vcf_block_tiles"


class VcfBlockTileRequest(BaseModel):
    start: int
    end: int
    level_id: str        # e.g. "L0" .. "L3" – used only in cache key
    block_bp: int        # size of each block stride (genomic bp)
    window_bp: int       # smoothing window around each stride centre


class VcfBlockTilesRequest(BaseModel):
    path: str
    chrom: str
    genome: Optional[str] = None
    coverage_threshold: float = 0.25
    tiles: List[VcfBlockTileRequest]


def _vcf_file_fingerprint(path: Path) -> Tuple[int, int]:
    st = path.stat()
    return int(st.st_mtime_ns), int(st.st_size)


def _vcf_has_tabix_index(path: Path) -> bool:
    return Path(str(path) + ".tbi").exists() or Path(str(path) + ".csi").exists()


def _get_vcf_lock(path: str) -> threading.Lock:
    with _VCF_HANDLE_LOCKS_GUARD:
        lock = _VCF_HANDLE_LOCKS.get(path)
        if lock is None:
            lock = threading.Lock()
            _VCF_HANDLE_LOCKS[path] = lock
        return lock


def _open_vcf_handle_unlocked(path: str):
    """Open or reuse the cached ``pysam.VariantFile`` for ``path``.

    Callers must hold the handle's lock — use :func:`locked_vcf` rather than
    calling this directly. htslib keeps seek state on the handle, and
    ``VariantFile.fetch()`` returns a lazy iterator, so the lock has to cover the
    whole scan and not merely the call that starts it.
    """
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"VCF not found: {path}")
    if str(p).lower().endswith(".gz") and not _vcf_has_tabix_index(p):
        raise HTTPException(
            status_code=400,
            detail=f"VCF index not found for {path}. Expected a matching .tbi or .csi file.",
        )
    fp = _vcf_file_fingerprint(p)
    key = str(p.resolve())
    with _VCF_HANDLE_CACHE_GUARD:
        cached = _VCF_HANDLE_CACHE.get(key)
        if cached and cached.get("fingerprint") == fp:
            return cached["handle"], fp, key

        if cached:
            try:
                cached["handle"].close()
            except Exception:
                pass

        try:
            handle = pysam.VariantFile(key)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not open VCF: {e}")

        _VCF_HANDLE_CACHE[key] = {"fingerprint": fp, "handle": handle}
        return handle, fp, key


@contextmanager
def locked_vcf(path: str):
    """Yield ``(handle, fingerprint, resolved_path)`` with exclusive access.

    The only supported way to reach a cached VCF handle. Holding the lock for the
    whole block matters more here than it does for FASTA: ``FastaFile.fetch()``
    does all its I/O before returning a string, whereas ``VariantFile.fetch()``
    hands back a lazy iterator that reads as it is consumed. Locking just the
    call that creates the iterator would leave the actual scan unguarded.

    The lock is per resolved path, so unrelated VCFs never block each other.
    """
    resolved = str(Path(path).resolve())
    lock = _get_vcf_lock(resolved)
    with lock:
        yield _open_vcf_handle_unlocked(path)


def _resolve_vcf_chrom(vcf_handle, chrom: str) -> Optional[str]:
    name = str(chrom or "").strip()
    if not name:
        return None
    contigs = set(vcf_handle.header.contigs.keys())
    if name in contigs:
        return name
    if name.startswith("chr") and name[3:] in contigs:
        return name[3:]
    prefixed = f"chr{name}"
    if prefixed in contigs:
        return prefixed
    return None


def _classify_vcf_type(ref: str, alts: List[str]) -> str:
    if len(ref) == 1 and all(len(a) == 1 for a in alts):
        return "snv"
    if any(len(a) > len(ref) for a in alts):
        return "ins"
    if any(len(a) < len(ref) for a in alts):
        return "del"
    return "other"


def _extract_consequence_terms(info: Any) -> List[str]:
    if not info:
        return []
    try:
        csq = info.get("CSQ")
    except Exception:
        csq = None
    try:
        ann = info.get("ANN")
    except Exception:
        ann = None
    source = csq if csq is not None else ann
    if source is None:
        return []
    entries = list(source) if isinstance(source, (tuple, list)) else [source]
    terms: List[str] = []
    for entry in entries:
        if entry is None:
            continue
        text = str(entry)
        chunks = text.split(",")
        for chunk in chunks:
            fields = chunk.split("|")
            if csq is not None:
                consequence = fields[1] if len(fields) > 1 else fields[0]
            else:
                consequence = fields[1] if len(fields) > 1 else fields[0]
            for term in consequence.replace("&", ",").split(","):
                t = term.strip().lower()
                if t:
                    terms.append(t)
    return terms


def _effect_group_from_terms(terms: List[str]) -> str:
    if not terms:
        return "other"
    term_set = set(terms)
    if term_set & _VCF_PROTEIN_TERMS:
        return "protein_altering"
    if term_set & _VCF_SPLICING_TERMS:
        return "splicing"
    if term_set & _VCF_REGULATORY_TERMS:
        return "regulatory"
    if term_set & _VCF_INTERGENIC_TERMS:
        return "intergenic"
    if term_set & _VCF_TRANSCRIPT_TERMS:
        return "transcript"
    # Lightweight fallback buckets by lexical hints
    if any("splice" in t for t in term_set):
        return "splicing"
    if any("intergenic" in t or "upstream" in t or "downstream" in t for t in term_set):
        return "intergenic"
    if any("regulatory" in t or "tf_binding" in t for t in term_set):
        return "regulatory"
    if any("protein" in t or "coding" in t for t in term_set):
        return "protein_altering"
    if any("transcript" in t or "intron" in t or "utr" in t for t in term_set):
        return "transcript"
    return "other"


def _vcf_effect_group(rec, include_effects: bool) -> str:
    if not include_effects:
        return "other"
    try:
        terms = _extract_consequence_terms(rec.info)
    except Exception:
        return "other"
    return _effect_group_from_terms(terms)


def _vcf_type_counts_dict() -> Dict[str, int]:
    return {"snv": 0, "ins": 0, "del": 0, "other": 0}


def _load_vcf_gene_intervals(genome: Optional[str], chrom: str, start: int, end: int) -> List[Tuple[int, int]]:
    g = str(genome or "").strip()
    if not g:
        return []
    try:
        db_path = genome_context._get_browse_db(g)
    except Exception:
        return []
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute(
        """
        SELECT start, end
        FROM genes
        WHERE chrom = ? AND end >= ? AND start <= ?
        ORDER BY start ASC
        """,
        (chrom, start, end),
    )
    rows = c.fetchall()
    conn.close()
    out: List[Tuple[int, int]] = []
    for r in rows:
        try:
            s = int(r[0])
            e = int(r[1])
        except Exception:
            continue
        if e >= s:
            out.append((s, e))
    return out


def _make_gene_overlap_checker(gene_intervals: List[Tuple[int, int]]):
    intervals = sorted(gene_intervals, key=lambda x: x[0])
    state = {"idx": 0, "last_start": -1}

    def overlaps(q_start: int, q_end: int) -> bool:
        if not intervals:
            return False
        q_start_i = int(q_start)
        q_end_i = int(q_end)
        if q_end_i < q_start_i:
            q_start_i, q_end_i = q_end_i, q_start_i

        idx = int(state["idx"])
        if q_start_i < int(state["last_start"]):
            idx = 0
        n = len(intervals)
        while idx < n and intervals[idx][1] < q_start_i:
            idx += 1
        state["idx"] = idx
        state["last_start"] = q_start_i
        j = idx
        while j < n and intervals[j][0] <= q_end_i:
            if intervals[j][1] >= q_start_i:
                return True
            j += 1
        return False

    return overlaps


def _classify_variant_context(rec, include_effects: bool, gene_overlap_fn=None) -> str:
    terms: List[str] = []
    if include_effects:
        try:
            terms = _extract_consequence_terms(rec.info)
        except Exception:
            terms = []
    if terms:
        term_set = set(terms)
        if term_set & _VCF_INTERGENIC_TERMS:
            return "intergenic"
        if term_set & (_VCF_TRANSCRIPT_TERMS | _VCF_PROTEIN_TERMS | _VCF_SPLICING_TERMS | _VCF_REGULATORY_TERMS):
            return "transcript"
        if any("intergenic" in t or "upstream" in t or "downstream" in t for t in term_set):
            return "intergenic"
        if any("transcript" in t or "intron" in t or "utr" in t or "coding" in t or "splice" in t for t in term_set):
            return "transcript"

    if gene_overlap_fn is not None:
        pos = int(rec.pos)
        ref_len = max(1, len(str(rec.ref or "")))
        rec_end = int(getattr(rec, "stop", pos + ref_len - 1))
        if gene_overlap_fn(pos, max(pos, rec_end)):
            return "transcript"
    return "intergenic"


def _build_vcf_block_spans(
    tile_start: int,
    tile_end: int,
    block_window_bp: int,
    block_stride_bp: int,
    block_coverage_threshold: float,
    variant_intervals: List[Tuple[int, int, str]],
) -> List[Dict[str, Any]]:
    span = max(1, int(tile_end) - int(tile_start))
    stride_bp = max(1, int(block_stride_bp))
    window_bp = max(1, int(block_window_bp))
    threshold = max(0.0, min(1.0, float(block_coverage_threshold)))
    slot_count = max(1, math.ceil(span / stride_bp))

    any_cov = [0.0] * slot_count
    tx_cov = [0.0] * slot_count
    inter_cov = [0.0] * slot_count

    def slot_bounds(i: int) -> Tuple[int, int]:
        s = tile_start + i * stride_bp
        e = min(tile_end, s + stride_bp)
        return s, e

    for v_start, v_end, cls in variant_intervals:
        s = max(tile_start, int(v_start))
        e = min(tile_end, int(v_end))
        if e <= s:
            continue
        i1 = max(0, min(slot_count - 1, int((s - tile_start) // stride_bp)))
        i2 = max(0, min(slot_count - 1, int((max(s, e - 1) - tile_start) // stride_bp)))
        for i in range(i1, i2 + 1):
            ss, se = slot_bounds(i)
            ov = max(0.0, min(float(e), float(se)) - max(float(s), float(ss)))
            if ov <= 0:
                continue
            slot_len = max(1.0, float(se - ss))
            any_cov[i] = min(slot_len, any_cov[i] + ov)
            if cls == "transcript":
                tx_cov[i] = min(slot_len, tx_cov[i] + ov)
            else:
                inter_cov[i] = min(slot_len, inter_cov[i] + ov)

    effective_window = min(window_bp, span)
    starts: List[int] = []
    if span <= effective_window:
        starts = [tile_start]
    else:
        s = tile_start
        last = tile_end - effective_window
        while s <= last:
            starts.append(s)
            s += stride_bp
        if not starts or starts[-1] != last:
            starts.append(last)

    painted_class: List[Optional[str]] = [None] * slot_count
    painted_cov: List[float] = [0.0] * slot_count

    for ws in starts:
        we = min(tile_end, ws + effective_window)
        i1 = max(0, min(slot_count - 1, int((ws - tile_start) // stride_bp)))
        i2 = max(0, min(slot_count - 1, int((max(ws, we - 1) - tile_start) // stride_bp)))
        any_bp = 0.0
        tx_bp = 0.0
        inter_bp = 0.0
        for i in range(i1, i2 + 1):
            ss, se = slot_bounds(i)
            slot_ov = max(0.0, min(float(we), float(se)) - max(float(ws), float(ss)))
            if slot_ov <= 0:
                continue
            slot_len = max(1.0, float(se - ss))
            frac = slot_ov / slot_len
            any_bp += any_cov[i] * frac
            tx_bp += tx_cov[i] * frac
            inter_bp += inter_cov[i] * frac
        window_len = max(1.0, float(we - ws))
        cov_frac = max(0.0, min(1.0, any_bp / window_len))
        state = None
        if cov_frac >= threshold:
            state = "transcript" if tx_bp >= inter_bp else "intergenic"

        for i in range(i1, i2 + 1):
            ss, se = slot_bounds(i)
            if se <= ws or ss >= we:
                continue
            painted_class[i] = state
            painted_cov[i] = cov_frac

    spans_out: List[Dict[str, Any]] = []
    run_class: Optional[str] = None
    run_start = 0
    run_cov_sum = 0.0
    run_n = 0
    for i, cls in enumerate(painted_class):
        if cls is None:
            if run_class is not None:
                s0, _ = slot_bounds(run_start)
                _, e0 = slot_bounds(i - 1)
                spans_out.append({
                    "start": int(s0),
                    "end": int(e0),
                    "class_name": run_class,
                    "coverage_fraction": float(run_cov_sum / max(1, run_n)),
                })
                run_class = None
            continue
        if run_class is None:
            run_class = cls
            run_start = i
            run_cov_sum = painted_cov[i]
            run_n = 1
        elif cls == run_class:
            run_cov_sum += painted_cov[i]
            run_n += 1
        else:
            s0, _ = slot_bounds(run_start)
            _, e0 = slot_bounds(i - 1)
            spans_out.append({
                "start": int(s0),
                "end": int(e0),
                "class_name": run_class,
                "coverage_fraction": float(run_cov_sum / max(1, run_n)),
            })
            run_class = cls
            run_start = i
            run_cov_sum = painted_cov[i]
            run_n = 1
    if run_class is not None:
        s0, _ = slot_bounds(run_start)
        _, e0 = slot_bounds(slot_count - 1)
        spans_out.append({
            "start": int(s0),
            "end": int(e0),
            "class_name": run_class,
            "coverage_fraction": float(run_cov_sum / max(1, run_n)),
        })
    return spans_out


def _build_vcf_summary_tile(
    vcf_handle,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    max_variants: int,
    include_effects: bool,
    block_window_bp: int,
    block_stride_bp: int,
    block_coverage_threshold: float,
    block_mode: str,
    gene_intervals: Optional[List[Tuple[int, int]]] = None,
) -> Dict[str, Any]:
    span = max(1, end - start)
    block_mode_norm = str(block_mode or "coverage_spans").strip().lower()
    counts = [0] * bins
    occupancy = [0] * bins
    type_counts_bins = [_vcf_type_counts_dict() for _ in range(bins)]
    effect_counts_bins = [{g: 0 for g in _VCF_EFFECT_GROUPS} for _ in range(bins)]
    effect_obs_bins = [0] * bins
    truncated = False
    seen = 0

    variant_intervals: List[Tuple[int, int, str]] = []
    overlap_checker = _make_gene_overlap_checker(gene_intervals or []) if gene_intervals else None

    def process_record(rec):
        nonlocal seen
        seen += 1

        pos = int(rec.pos)
        idx = int((pos - start) / span * bins)
        idx = max(0, min(bins - 1, idx))
        counts[idx] += 1
        occupancy[idx] = 1

        ref = str(rec.ref or "")
        alts = [str(a) for a in (rec.alts or [])]
        vtype = _classify_vcf_type(ref, alts)
        type_counts_bins[idx][vtype] = int(type_counts_bins[idx].get(vtype, 0)) + 1

        if include_effects:
            # Bound effect parsing work per bin for dense tiles while preserving
            # dominant consequence trends.
            if effect_obs_bins[idx] < 256:
                group = _vcf_effect_group(rec, include_effects)
                effect_counts_bins[idx][group] = int(effect_counts_bins[idx].get(group, 0)) + 1
                effect_obs_bins[idx] += 1

        pos = int(rec.pos)
        ref_len = max(1, len(str(rec.ref or "")))
        rec_end = int(getattr(rec, "stop", pos + ref_len - 1))
        s = max(start, pos)
        e_excl = min(end, max(pos, rec_end) + 1)
        if e_excl > s:
            cls = _classify_variant_context(rec, include_effects, overlap_checker)
            variant_intervals.append((s, e_excl, cls))

    # Bounded, window-distributed sampling avoids expensive full scans on dense
    # files while preventing the old left-biased "first N records only" artefact.
    # Keep this for all block modes so VCF work doesn't starve core gene/transcript
    # browsing responsiveness.
    if max_variants > 0:
        window_count = max(16, min(400, bins))
        window_span = max(1, math.ceil(span / window_count))
        per_window_budget = max(32, math.ceil(max_variants / window_count))
        for wi in range(window_count):
            w_start = start + wi * window_span
            if w_start >= end:
                break
            w_end = min(end, w_start + window_span)
            fetch_start = max(0, (w_start - 1) if wi == 0 else w_start)
            idx_lo = max(0, min(bins - 1, int(((w_start - start) / span) * bins)))
            idx_hi = max(0, min(bins - 1, int((((w_end - 1) - start) / span) * bins)))
            if idx_hi < idx_lo:
                idx_lo, idx_hi = idx_hi, idx_lo
            bin_total = max(1, idx_hi - idx_lo + 1)
            per_bin_budget = max(8, math.ceil(per_window_budget / bin_total))
            window_counts: Dict[int, int] = {}
            saturated: Set[int] = set()
            for rec in vcf_handle.fetch(chrom, fetch_start, w_end):
                pos = int(rec.pos)
                idx = int((pos - start) / span * bins)
                idx = max(0, min(bins - 1, idx))
                existing = int(window_counts.get(idx, 0))
                if existing >= per_bin_budget:
                    continue
                process_record(rec)
                next_count = existing + 1
                window_counts[idx] = next_count
                if next_count >= per_bin_budget:
                    saturated.add(idx)
                    if len(saturated) >= bin_total:
                        truncated = True
                        break
    else:
        for rec in vcf_handle.fetch(chrom, max(0, start - 1), end):
            process_record(rec)

    dominant_effect_bins: List[str] = []
    for i in range(bins):
        bucket = effect_counts_bins[i]
        if sum(bucket.values()) <= 0:
            dominant_effect_bins.append("other")
            continue
        best_group = max(_VCF_EFFECT_GROUPS, key=lambda g: bucket.get(g, 0))
        dominant_effect_bins.append(best_group)

    block_window = max(1, int(block_window_bp or 10000))
    block_stride = max(1, int(block_stride_bp or max(1, block_window // 10)))
    block_threshold = max(0.0, min(1.0, float(block_coverage_threshold)))
    block_spans = _build_vcf_block_spans(
        start,
        end,
        block_window,
        block_stride,
        block_threshold,
        variant_intervals,
    ) if block_mode_norm == "coverage_spans" else []

    return {
        "has_data": bool(seen > 0),
        "bins": counts,
        "max_count": max(counts) if counts else 0,
        "occupancy": occupancy,
        "dominant_effect_bins": dominant_effect_bins,
        "type_counts_bins": type_counts_bins,
        "truncated": truncated,
        "block_window_bp": int(block_window),
        "block_stride_bp": int(block_stride),
        "block_coverage_threshold": float(block_threshold),
        "block_spans": block_spans,
    }


def _build_vcf_detail_tile(vcf_handle, chrom: str, start: int, end: int, max_variants: int, include_effects: bool) -> Dict[str, Any]:
    variants: List[Dict[str, Any]] = []
    truncated = False

    for rec in vcf_handle.fetch(chrom, max(0, start - 1), end):
        if len(variants) >= max_variants:
            truncated = True
            break
        ref = str(rec.ref or "")
        alts = [str(a) for a in (rec.alts or [])]
        vtype = _classify_vcf_type(ref, alts)
        effect_group = _vcf_effect_group(rec, include_effects)
        label = "SNV" if vtype == "snv" else ("INS" if vtype == "ins" else ("DEL" if vtype == "del" else "VAR"))
        rec_end = int(getattr(rec, "stop", rec.pos + max(1, len(ref)) - 1))
        variants.append({
            "pos": int(rec.pos),
            "end": max(int(rec.pos), rec_end),
            "ref": ref[:40],
            "alt": ",".join(alts)[:80],
            "type": vtype,
            "id": str(rec.id or "."),
            "effect_group": effect_group,
            "label": label,
        })

    return {
        "has_data": bool(variants),
        "variants": variants,
        "truncated": truncated,
    }


def _vcf_disk_cache_key(
    vcf_path: str,
    fingerprint: Tuple[int, int],
    chrom: str,
    tile: VcfTileRequest,
    include_effects: bool,
) -> str:
    payload = "|".join([
        _VCF_TILE_CACHE_SCHEMA,
        str(vcf_path),
        str(fingerprint[0]),
        str(fingerprint[1]),
        str(chrom),
        str(tile.start),
        str(tile.end),
        str(tile.lod),
        str(tile.mode),
        str(tile.bins),
        str(tile.max_variants),
        str(tile.block_window_bp or ""),
        str(tile.block_stride_bp or ""),
        str(tile.block_coverage_threshold if tile.block_coverage_threshold is not None else ""),
        str(tile.block_mode or ""),
        "1" if include_effects else "0",
    ])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _vcf_disk_cache_path(key: str) -> Path:
    return _VCF_TILE_DISK_CACHE_DIR / f"{key}.json"


def _load_vcf_tile_disk_cache(key: str) -> Optional[Dict[str, Any]]:
    p = _vcf_disk_cache_path(key)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _save_vcf_tile_disk_cache(key: str, payload: Dict[str, Any]) -> None:
    p = _vcf_disk_cache_path(key)
    try:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    except Exception:
        pass


# ── Block-tile disk cache helpers ────────────────────────────────────────────

def _vcf_block_tile_disk_cache_key(
    vcf_path: str,
    fingerprint: Tuple[int, int],
    chrom: str,
    tile: "VcfBlockTileRequest",
    coverage_threshold: float,
) -> str:
    payload = "|".join([
        _VCF_BLOCK_TILE_CACHE_SCHEMA,
        str(vcf_path),
        str(fingerprint[0]),
        str(fingerprint[1]),
        str(chrom),
        str(tile.start),
        str(tile.end),
        str(tile.level_id),
        str(tile.block_bp),
        str(tile.window_bp),
        f"{coverage_threshold:.4f}",
    ])
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _vcf_block_tile_cache_path(key: str) -> Path:
    return _VCF_BLOCK_TILE_DISK_CACHE_DIR / f"{key}.json"


def _load_vcf_block_tile_cache(key: str) -> Optional[Dict[str, Any]]:
    p = _vcf_block_tile_cache_path(key)
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def _save_vcf_block_tile_cache(key: str, payload: Dict[str, Any]) -> None:
    p = _vcf_block_tile_cache_path(key)
    try:
        with open(p, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
    except Exception:
        pass


# ── Core block-span computation (full scan + prefix-sum sliding window) ──────

def _build_vcf_block_spans_fast(
    vcf_handle,
    chrom: str,
    tile_start: int,
    tile_end: int,
    block_bp: int,
    window_bp: int,
    coverage_threshold: float,
    gene_intervals: List[Tuple[int, int]],
    level_id: str = "",
) -> Dict[str, Any]:
    """
    Full-tile scan with 100 bp density bins and prefix-sum sliding window.

    Returns:
      - block_spans: merged {start, end, class_name} spans for coarse block rendering
      - density_bins: local variant enrichment per stride (>=0, ~1 means baseline)
      - density_classes: class per stride ('genic' | 'intergenic')
      - density_stride_bp: genomic width of each density stride
    """
    BIN = VCF_BLOCK_DENSITY_BIN_BP
    tile_span = max(1, tile_end - tile_start)
    block_bp = max(BIN, int(block_bp))
    window_bp = max(block_bp, int(window_bp))
    threshold = max(0.0, min(1.0, float(coverage_threshold)))

    n_bins = (tile_span + BIN - 1) // BIN

    # ── 1. Build occupancy + count arrays per 100 bp bin ─────────────────
    # `occupied` is binary for stable block-span thresholding.
    # `variant_counts` captures local rate differences for the density profile.
    occupied: List[int] = [0] * n_bins
    variant_counts: List[int] = [0] * n_bins
    for rec in vcf_handle.fetch(chrom, max(0, tile_start - 1), tile_end):
        pos = int(rec.pos)
        if pos < tile_start or pos >= tile_end:
            continue

        b = min(n_bins - 1, (pos - tile_start) // BIN)
        occupied[b] = 1   # binary: mark bin as occupied
        variant_counts[b] += 1

    # ── 2. Occupancy/count prefix sums ────────────────────────────────────
    var_psum: List[int] = [0] * (n_bins + 1)
    count_psum: List[int] = [0] * (n_bins + 1)
    for i in range(n_bins):
        var_psum[i + 1] = var_psum[i] + occupied[i]
        count_psum[i + 1] = count_psum[i] + variant_counts[i]
    global_mean_per_bin = (count_psum[n_bins] / max(1, n_bins)) if n_bins > 0 else 0.0

    # ── 3. Gene mask (1 if any gene covers any position in this bin) ──────
    gene_bins: List[int] = [0] * n_bins
    for g_start, g_end in gene_intervals:
        lo = max(0, (g_start - tile_start) // BIN)
        hi = min(n_bins - 1, (g_end - tile_start) // BIN)
        for b in range(lo, hi + 1):
            gene_bins[b] = 1

    gene_psum: List[int] = [0] * (n_bins + 1)
    for i in range(n_bins):
        gene_psum[i + 1] = gene_psum[i] + gene_bins[i]

    def _query_psum(psum: List[int], rel_lo: int, rel_hi: int) -> int:
        """Sum psum over [rel_lo, rel_hi) genomic coords relative to tile_start."""
        b_lo = max(0, rel_lo // BIN)
        b_hi = min(n_bins, (rel_hi + BIN - 1) // BIN)
        return psum[b_hi] - psum[b_lo]

    # ── 4. Walk strides, classify, merge into spans ───────────────────────
    n_strides = max(1, (tile_span + block_bp - 1) // block_bp)
    win_half = window_bp // 2

    spans_out: List[Dict[str, Any]] = []
    density_bins: List[float] = []
    density_classes: List[str] = []
    run_cls: Optional[str] = None
    run_start = tile_start

    for si in range(n_strides):
        stride_start = tile_start + si * block_bp
        stride_end = min(tile_end, stride_start + block_bp)
        stride_center = (stride_start + stride_end) // 2

        win_lo = max(tile_start, stride_center - win_half)
        win_hi = min(tile_end, stride_center + win_half)
        # Number of 100 bp bins in this window (denominator for occupancy fraction)
        win_bins = max(1, (win_hi - win_lo + BIN - 1) // BIN)

        # Coverage fraction drives block spans (kept as binary occupancy fraction).
        occ_count = _query_psum(var_psum, win_lo - tile_start, win_hi - tile_start)
        cov_frac = occ_count / win_bins

        # Density profile uses local enrichment relative to tile-wide background.
        # Around 1.0 means baseline density, >1 hotspot, <1 depleted.
        var_count = _query_psum(count_psum, win_lo - tile_start, win_hi - tile_start)
        local_mean_per_bin = var_count / max(1, win_bins)
        if global_mean_per_bin > 0:
            enrichment = local_mean_per_bin / global_mean_per_bin
        else:
            enrichment = 0.0

        gene_count = _query_psum(gene_psum, win_lo - tile_start, win_hi - tile_start)
        stride_cls = "genic" if gene_count > win_bins * 0.5 else "intergenic"
        density_bins.append(max(0.0, min(16.0, float(enrichment))))
        density_classes.append(stride_cls)

        if cov_frac >= threshold:
            cls: Optional[str] = stride_cls
        else:
            cls = None   # gap

        if cls != run_cls:
            if run_cls is not None:
                spans_out.append({"start": run_start, "end": stride_start, "class_name": run_cls})
            run_cls = cls
            run_start = stride_start

    if run_cls is not None:
        spans_out.append({"start": run_start, "end": tile_end, "class_name": run_cls})

    return {
        "block_spans": spans_out,
        "density_bins": density_bins,
        "density_classes": density_classes,
        "density_stride_bp": int(block_bp),
    }


def _browse_vcf_block_tiles_sync(payload: "VcfBlockTilesRequest") -> Dict[str, Any]:
    if not payload.tiles:
        raise HTTPException(status_code=400, detail="tiles must not be empty")

    path = str(payload.path or "").strip()
    chrom_req = str(payload.chrom or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    if not chrom_req:
        raise HTTPException(status_code=400, detail="chrom is required")

    coverage_threshold = max(0.0, min(1.0, float(payload.coverage_threshold or 0.5)))

    t_total0 = time.perf_counter()
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"VCF not found: {path}")

    with locked_vcf(path) as (vcf_handle, fingerprint, resolved_path):
        resolved_chrom = _resolve_vcf_chrom(vcf_handle, chrom_req)
        if not resolved_chrom:
            raise HTTPException(status_code=400, detail=f"Chromosome '{chrom_req}' not present in VCF")

        # Load gene intervals for the whole batch at once
        req_tile_start = min(max(0, int(t.start)) for t in payload.tiles)
        req_tile_end = max(max(int(t.start) + 1, int(t.end)) for t in payload.tiles)
        try:
            gene_intervals = _load_vcf_gene_intervals(payload.genome, resolved_chrom, req_tile_start, req_tile_end)
        except Exception:
            gene_intervals = []

        out_tiles: List[Dict[str, Any]] = []

        for tile in payload.tiles:
            tile_start = max(0, int(tile.start))
            tile_end = max(tile_start + 1, int(tile.end))

            cache_key = _vcf_block_tile_disk_cache_key(
                resolved_path, fingerprint, resolved_chrom, tile, coverage_threshold
            )
            cached = _load_vcf_block_tile_cache(cache_key)
            if cached is not None:
                out_tiles.append(cached)
                continue

            try:
                block_payload = _build_vcf_block_spans_fast(
                    vcf_handle,
                    resolved_chrom,
                    tile_start,
                    tile_end,
                    int(tile.block_bp),
                    int(tile.window_bp),
                    coverage_threshold,
                    gene_intervals,
                    str(tile.level_id or ""),
                )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not fetch VCF block tile. Ensure the VCF is bgzip-compressed and has a matching .tbi or .csi index: {exc}",
                )

            tile_payload: Dict[str, Any] = {
                "start": tile_start,
                "end": tile_end,
                "level_id": str(tile.level_id),
                "block_bp": int(tile.block_bp),
                "window_bp": int(tile.window_bp),
                "coverage_threshold": coverage_threshold,
                "block_spans": block_payload.get("block_spans", []),
                "density_bins": block_payload.get("density_bins", []),
                "density_classes": block_payload.get("density_classes", []),
                "density_stride_bp": int(block_payload.get("density_stride_bp") or int(tile.block_bp)),
            }
            _save_vcf_block_tile_cache(cache_key, tile_payload)
            out_tiles.append(tile_payload)

        total_ms = (time.perf_counter() - t_total0) * 1000.0
        logger.info(
            "VCF block tiles chrom=%s tiles=%d total=%.1fms",
            resolved_chrom, len(out_tiles), total_ms,
        )
        return {"chrom": resolved_chrom, "tiles": out_tiles}


def _browse_vcf_tiles_sync(payload: VcfTilesRequest) -> Dict[str, Any]:
    if not payload.tiles:
        raise HTTPException(status_code=400, detail="tiles must not be empty")

    path = str(payload.path or "").strip()
    chrom_req = str(payload.chrom or "").strip()
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    if not chrom_req:
        raise HTTPException(status_code=400, detail="chrom is required")

    t_total0 = time.perf_counter()
    p = Path(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"VCF not found: {path}")

    open_t0 = time.perf_counter()
    with locked_vcf(path) as (vcf_handle, fingerprint, resolved_path):
        resolved_chrom = _resolve_vcf_chrom(vcf_handle, chrom_req)
        if not resolved_chrom:
            raise HTTPException(status_code=400, detail=f"Chromosome '{chrom_req}' not present in VCF")
        open_ms = (time.perf_counter() - open_t0) * 1000.0

        req_tile_start = min(max(0, int(t.start)) for t in payload.tiles)
        req_tile_end = max(max(int(t.start) + 1, int(t.end)) for t in payload.tiles)
        gene_intervals: List[Tuple[int, int]] = []
        try:
            gene_intervals = _load_vcf_gene_intervals(payload.genome, resolved_chrom, req_tile_start, req_tile_end)
        except Exception:
            gene_intervals = []

        fetch_ms = 0.0
        agg_ms = 0.0
        serialize_ms = 0.0
        out_tiles: List[Dict[str, Any]] = []

        for tile in payload.tiles:
            tile_start = max(0, int(tile.start))
            tile_end = max(tile_start + 1, int(tile.end))
            tile_mode = str(tile.mode or "summary").strip().lower()
            if tile_mode not in {"summary", "detail"}:
                tile_mode = "summary"
            tile_bins = max(20, min(4000, int(tile.bins or 512)))
            tile_max_variants = max(100, min(1_000_000, int(tile.max_variants or 3000)))

            tile_req = VcfTileRequest(
                start=tile_start,
                end=tile_end,
                lod=str(tile.lod or "L2"),
                mode=tile_mode,
                bins=tile_bins,
                max_variants=tile_max_variants,
                block_window_bp=(int(tile.block_window_bp) if tile.block_window_bp is not None else None),
                block_stride_bp=(int(tile.block_stride_bp) if tile.block_stride_bp is not None else None),
                block_coverage_threshold=(
                    float(tile.block_coverage_threshold)
                    if tile.block_coverage_threshold is not None
                    else 0.5
                ),
                block_mode=str(tile.block_mode or "coverage_spans"),
            )
            lod_id = str(tile_req.lod or "").upper()
            want_effects = bool(payload.include_effects) and not (tile_mode == "summary" and lod_id in {"L0", "L1"})
            cache_key = _vcf_disk_cache_key(resolved_path, fingerprint, resolved_chrom, tile_req, want_effects)
            cached_payload = _load_vcf_tile_disk_cache(cache_key) if tile_mode == "summary" else None
            if cached_payload:
                out_tiles.append(cached_payload)
                continue

            t_fetch0 = time.perf_counter()
            t_agg0 = time.perf_counter()
            try:
                if tile_mode == "summary":
                    built = _build_vcf_summary_tile(
                        vcf_handle,
                        resolved_chrom,
                        tile_start,
                        tile_end,
                        tile_bins,
                        tile_max_variants,
                        want_effects,
                        int(tile_req.block_window_bp or 10000),
                        int(tile_req.block_stride_bp or max(1, int(tile_req.block_window_bp or 10000) // 10)),
                        float(tile_req.block_coverage_threshold if tile_req.block_coverage_threshold is not None else 0.5),
                        str(tile_req.block_mode or "coverage_spans"),
                        gene_intervals,
                    )
                else:
                    built = _build_vcf_detail_tile(
                        vcf_handle,
                        resolved_chrom,
                        tile_start,
                        tile_end,
                        tile_max_variants,
                        want_effects,
                    )
            except HTTPException:
                raise
            except Exception as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Could not fetch VCF tile. Ensure the VCF is bgzip-compressed and has a matching .tbi or .csi index: {exc}",
                )
            agg_ms += (time.perf_counter() - t_agg0) * 1000.0
            fetch_ms += (time.perf_counter() - t_fetch0) * 1000.0

            t_ser0 = time.perf_counter()
            tile_payload = {
                "start": tile_start,
                "end": tile_end,
                "lod": str(tile_req.lod or "L2"),
                "mode": tile_mode,
                **built,
            }
            serialize_ms += (time.perf_counter() - t_ser0) * 1000.0

            if tile_mode == "summary":
                _save_vcf_tile_disk_cache(cache_key, tile_payload)
            out_tiles.append(tile_payload)

        total_ms = (time.perf_counter() - t_total0) * 1000.0
        logger.info(
            "VCF tile timings chrom=%s tiles=%d open=%.1fms fetch=%.1fms agg=%.1fms serialize=%.1fms total=%.1fms",
            resolved_chrom,
            len(out_tiles),
            open_ms,
            fetch_ms,
            agg_ms,
            serialize_ms,
            total_ms,
        )
        return {"chrom": resolved_chrom, "tiles": out_tiles}


@router.post("/api/browse/vcf/tiles")
async def browse_vcf_tiles(payload: VcfTilesRequest):
    return await run_in_threadpool(_browse_vcf_tiles_sync, payload)


@router.post("/api/browse/vcf/block_tiles")
async def browse_vcf_block_tiles(payload: VcfBlockTilesRequest):
    return await run_in_threadpool(_browse_vcf_block_tiles_sync, payload)


@router.get("/api/browse/vcf")
async def browse_vcf(
    path: str,
    chrom: str,
    start: int,
    end: int,
    bins: int = 500,
    level: str = "fine",          # 'overview'|'region'|'gene'|'fine'
    max_variants: int = 5000,
):
    mode = "detail" if str(level).lower() == "fine" else "summary"
    req = VcfTilesRequest(
        path=path,
        chrom=chrom,
        include_effects=True,
        tiles=[VcfTileRequest(
            start=start,
            end=end,
            lod=str(level or "L2"),
            mode=mode,
            bins=bins,
            max_variants=max_variants,
        )],
    )
    result = await run_in_threadpool(_browse_vcf_tiles_sync, req)
    tile = result.get("tiles", [{}])[0] if result.get("tiles") else {}

    if mode == "detail":
        return {
            "level": level,
            "start": start,
            "end": end,
            "variants": tile.get("variants", []),
            "truncated": bool(tile.get("truncated")),
            "has_data": bool(tile.get("has_data")),
        }

    return {
        "level": level,
        "start": start,
        "end": end,
        "bins": tile.get("bins", []),
        "max_count": tile.get("max_count", 0),
        "occupancy": tile.get("occupancy", []),
        "dominant_effect_bins": tile.get("dominant_effect_bins", []),
        "type_counts_bins": tile.get("type_counts_bins", []),
        "truncated": bool(tile.get("truncated")),
        "has_data": bool(tile.get("has_data")),
    }
