"""Splice-junction tracks: reading junctions from STAR SJ.out.tab and bigBed files,
classifying them as canonical or annotated against the genome's own introns (with per-
file caches), and the junction and junction-block tile endpoints.
"""

import gzip
import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

import genome_context
import routes.tracks
import sequence_windows
from assembly_report import chrom_token_variants

router = APIRouter()


class SpliceBlockTileRequest(BaseModel):
    start: int
    end: int
    level_id: str = "L0"
    block_bp: int = 5000


class SpliceBlockTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[SpliceBlockTileRequest]
    genome: str = "reference"
    track_id: Optional[str] = None
    min_reads: int = 1
    min_support: Optional[int] = None
    canonical_mode: Optional[str] = None
    annotated_mode: Optional[str] = None
    max_junctions: Optional[int] = None


_SJ_CHROM_CACHE: Dict[str, Dict[str, Any]] = {}


_SJ_CHROM_CACHE_LOCK = threading.Lock()


_SPLICE_DB_CHROMS_CACHE: Dict[str, Dict[str, Any]] = {}


_SPLICE_DB_CHROMS_CACHE_LOCK = threading.Lock()


_SPLICE_ANNOTATED_INTRON_CACHE: Dict[str, Dict[str, Any]] = {}


_SPLICE_ANNOTATED_INTRON_CACHE_LOCK = threading.Lock()


def _get_sj_available_chroms(path: Path) -> List[str]:
    key = str(path.resolve())
    try:
        st = path.stat()
        sig = (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        sig = (0, 0)

    with _SJ_CHROM_CACHE_LOCK:
        cached = _SJ_CHROM_CACHE.get(key)
        if cached and cached.get("sig") == sig:
            return list(cached.get("chroms") or [])

    chroms: Set[str] = set()
    opener = gzip.open if str(path).endswith(".gz") else open
    try:
        with opener(str(path), "rt") as fh:
            for line in fh:
                raw = line.strip()
                if not raw:
                    continue
                cols = raw.split("\t")
                if not cols:
                    continue
                name = str(cols[0] or "").strip()
                if name:
                    chroms.add(name)
    except Exception:
        chroms = set()

    ordered = sorted(chroms)
    with _SJ_CHROM_CACHE_LOCK:
        _SJ_CHROM_CACHE[key] = {"sig": sig, "chroms": ordered}
    return ordered


def _db_file_signature(path: str) -> Tuple[int, int]:
    try:
        st = os.stat(path)
        return (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        return (0, 0)


def _get_transcript_db_chroms(db_path: str) -> List[str]:
    resolved = str(Path(db_path).expanduser().resolve())
    sig = _db_file_signature(resolved)
    with _SPLICE_DB_CHROMS_CACHE_LOCK:
        cached = _SPLICE_DB_CHROMS_CACHE.get(resolved)
        if cached and cached.get("sig") == sig:
            return list(cached.get("chroms") or [])

    chroms: List[str] = []
    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute("SELECT DISTINCT chrom FROM transcripts")
        chroms = [str(r["chrom"] or "").strip() for r in c.fetchall() if str(r["chrom"] or "").strip()]
    except Exception:
        chroms = []
    finally:
        conn.close()

    with _SPLICE_DB_CHROMS_CACHE_LOCK:
        _SPLICE_DB_CHROMS_CACHE[resolved] = {"sig": sig, "chroms": chroms}
    return chroms


def _resolve_splice_annotation_chrom(genome: str, db_path: str, requested: str) -> Optional[str]:
    token = str(requested or "").strip()
    if not token:
        return None
    known = _get_transcript_db_chroms(db_path)
    if not known:
        return None
    if token in known:
        return token

    lower = token.lower()
    for name in known:
        if name.lower() == lower:
            return name

    query_tokens = chrom_token_variants(token)
    variant_matches = [name for name in known if chrom_token_variants(name) & query_tokens]
    if len(variant_matches) == 1:
        return variant_matches[0]

    resolved = genome_context._resolve_browse_chrom_name(genome, token, known)
    if resolved in known:
        return resolved
    resolved_l = str(resolved or "").lower()
    if resolved_l:
        for name in known:
            if name.lower() == resolved_l:
                return name

    if variant_matches:
        return sorted(variant_matches, key=lambda v: (len(v), v.lower()))[0]
    return None


def _load_splice_annotated_intron_pairs(db_path: str, chrom: str) -> Set[Tuple[int, int]]:
    resolved_db = str(Path(db_path).expanduser().resolve())
    token = str(chrom or "").strip()
    if not token:
        return set()

    sig = _db_file_signature(resolved_db)
    cache_key = f"{resolved_db}|{token}"
    with _SPLICE_ANNOTATED_INTRON_CACHE_LOCK:
        cached = _SPLICE_ANNOTATED_INTRON_CACHE.get(cache_key)
        if cached and cached.get("sig") == sig:
            return set(cached.get("pairs") or [])

    pairs: Set[Tuple[int, int]] = set()
    conn = sqlite3.connect(resolved_db)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    try:
        c.execute("SELECT strand, data FROM transcripts WHERE chrom = ?", (token,))
        rows = c.fetchall()
    except Exception:
        rows = []
    finally:
        conn.close()

    for row in rows:
        strand = str(row["strand"] or "+").strip() or "+"
        raw_data = row["data"]
        try:
            tx_data = json.loads(raw_data) if raw_data else {}
        except Exception:
            tx_data = {}
        tx_data = tx_data if isinstance(tx_data, dict) else {}
        exons = sequence_windows._normalize_interval_list(tx_data.get("exons", []), "exon", strand)
        if len(exons) < 2:
            continue
        ordered = sorted(exons, key=lambda e: (int(e.get("start", 0) or 0), int(e.get("end", 0) or 0)))
        for idx in range(len(ordered) - 1):
            left = ordered[idx]
            right = ordered[idx + 1]
            intron_start = int(left.get("end", 0) or 0) + 1
            intron_end = int(right.get("start", 0) or 0) - 1
            if intron_start > 0 and intron_end >= intron_start:
                pairs.add((intron_start, intron_end))

    with _SPLICE_ANNOTATED_INTRON_CACHE_LOCK:
        _SPLICE_ANNOTATED_INTRON_CACHE[cache_key] = {
            "sig": sig,
            "pairs": list(pairs),
        }
    return pairs


def _resolve_splice_applied_settings(
    path: str,
    track_id: Optional[str],
    min_reads: int,
    min_support: Optional[int],
    canonical_mode: Optional[str],
    annotated_mode: Optional[str],
    max_junctions: Optional[int],
) -> Dict[str, Any]:
    track = routes.tracks._get_registered_track(track_id or "")
    registry_settings = None
    if track and track.get("type") == "splice_junctions":
        same_path = str(track.get("path") or "").strip() == str(path or "").strip()
        if same_path:
            registry_settings = routes.tracks._normalize_splice_settings(track.get("splice_settings"))

    applied = routes.tracks._normalize_splice_settings(registry_settings)
    applied["min_support"] = max(
        routes.tracks._to_int_or_default(min_reads, 1, minimum=1),
        routes.tracks._to_int_or_default(min_support, applied["min_support"], minimum=1),
    )
    if canonical_mode is not None:
        mode = str(canonical_mode).strip().lower()
        if mode in routes.tracks._CANONICAL_SPLICE_MODES:
            applied["canonical_mode"] = mode
    if annotated_mode is not None:
        mode = str(annotated_mode).strip().lower()
        if mode in routes.tracks._ANNOTATED_SPLICE_MODES:
            applied["annotated_mode"] = mode
    if max_junctions is not None:
        applied["max_junctions"] = routes.tracks._to_int_or_default(max_junctions, applied["max_junctions"], minimum=100, maximum=100_000)
    return applied


def _load_splice_local_annotation_pairs(genome: str, resolved_chrom: str, requested_chrom: str) -> Optional[Set[Tuple[int, int]]]:
    local_annotated_pairs: Optional[Set[Tuple[int, int]]] = None
    try:
        db_path = genome_context._get_browse_db(genome)
        db_chrom = _resolve_splice_annotation_chrom(genome, db_path, resolved_chrom)
        if not db_chrom:
            db_chrom = _resolve_splice_annotation_chrom(genome, db_path, requested_chrom)
        if db_chrom:
            local_annotated_pairs = _load_splice_annotated_intron_pairs(db_path, db_chrom)
    except HTTPException:
        local_annotated_pairs = None
    except Exception:
        local_annotated_pairs = None
    return local_annotated_pairs


def _collect_splice_junctions(
    sj_path: Path,
    resolved_chrom: str,
    start: int,
    end: int,
    applied: Dict[str, Any],
    local_annotated_pairs: Optional[Set[Tuple[int, int]]],
) -> List[Dict[str, Any]]:
    motif_map = {
        "0": "non-canonical",
        "1": "GT/AG",
        "2": "CT/AC",
        "3": "GC/AG",
        "4": "CT/GC",
        "5": "AT/AC",
        "6": "GT/AT",
    }
    junctions: List[Dict[str, Any]] = []
    opener = gzip.open if str(sj_path).endswith(".gz") else open
    with opener(str(sj_path), "rt") as fh:
        for line in fh:
            cols = line.strip().split("\t")
            if len(cols) < 7:
                continue
            jchrom = cols[0]
            if jchrom != resolved_chrom:
                continue
            try:
                jstart = int(cols[1])   # 1-based intron start
                jend = int(cols[2])     # 1-based intron end
            except ValueError:
                continue
            if jend < start or jstart > end:
                continue
            n_unique = int(cols[6]) if cols[6].isdigit() else 0
            n_multi = int(cols[7]) if len(cols) > 7 and cols[7].isdigit() else 0
            n_total = n_unique + n_multi
            if n_total < applied["min_support"]:
                continue
            strand_code = cols[3]  # 0=undefined,1=+,2=-
            strand = "." if strand_code == "0" else ("+" if strand_code == "1" else "-")
            motif = motif_map.get(cols[4], "unknown")
            star_annotated = cols[5] == "1"
            annotated = ((jstart, jend) in local_annotated_pairs) if local_annotated_pairs is not None else star_annotated
            canonical = routes.tracks._is_canonical_splice_motif(motif)
            if applied["canonical_mode"] == "canonical" and not canonical:
                continue
            if applied["canonical_mode"] == "non_canonical" and canonical:
                continue
            if applied["annotated_mode"] == "annotated" and not annotated:
                continue
            if applied["annotated_mode"] == "novel" and annotated:
                continue
            junctions.append({
                "chrom": jchrom,
                "start": jstart,  # 1-based, intron start
                "end": jend,      # 1-based, intron end
                "strand": strand,
                "motif": motif,
                "canonical": canonical,
                "annotated": annotated,
                "star_annotated": star_annotated,
                "n_unique": n_unique,
                "n_multi": n_multi,
                "n_total": n_total,
            })

    junctions.sort(
        key=lambda j: (
            -int(j.get("n_total", 0)),
            int(j.get("start", 0)),
            int(j.get("end", 0)),
            str(j.get("strand", ".")),
        )
    )
    if len(junctions) > applied["max_junctions"]:
        junctions = junctions[:applied["max_junctions"]]
    return junctions


def _build_splice_block_spans_from_junctions(
    junctions: List[Dict[str, Any]],
    tile_start: int,
    tile_end: int,
    block_bp: int,
) -> Tuple[List[Dict[str, Any]], int]:
    span = max(1, tile_end - tile_start)
    block_size = max(1, int(block_bp))
    slot_count = max(1, (span + block_size - 1) // block_size)
    active = [0] * slot_count
    max_support = [0] * slot_count

    for jn in junctions:
        jstart = int(jn.get("start", 0) or 0)
        jend = int(jn.get("end", 0) or 0)
        if jend <= tile_start or jstart >= tile_end:
            continue
        ov_start = max(tile_start, jstart)
        ov_end = min(tile_end, jend)
        if ov_end <= ov_start:
            continue
        b0 = max(0, min(slot_count - 1, (ov_start - tile_start) // block_size))
        b1 = max(0, min(slot_count - 1, (max(ov_start, ov_end - 1) - tile_start) // block_size))
        support = max(0, int(jn.get("n_total", 0) or 0))
        for idx in range(b0, b1 + 1):
            active[idx] = 1
            if support > max_support[idx]:
                max_support[idx] = support

    spans: List[Dict[str, Any]] = []
    painted_bp = 0
    idx = 0
    while idx < slot_count:
        if active[idx] == 0:
            idx += 1
            continue
        run_start = idx
        run_max = max_support[idx]
        idx += 1
        while idx < slot_count and active[idx] == 1:
            run_max = max(run_max, max_support[idx])
            idx += 1
        run_end = idx - 1
        start_bp = tile_start + run_start * block_size
        end_bp = min(tile_end, tile_start + (run_end + 1) * block_size)
        if end_bp > start_bp:
            spans.append({
                "start": int(start_bp),
                "end": int(end_bp),
                "max_support": int(run_max),
            })
            painted_bp += (end_bp - start_bp)

    return spans, painted_bp


# ── STAR Splice Junctions endpoint ───────────────────────────────────────────

@router.get("/api/browse/splice_junctions")
async def browse_splice_junctions(
    path: str,
    chrom: str,
    start: int,
    end: int,
    genome: str = "reference",
    track_id: Optional[str] = None,
    min_reads: int = 1,
    min_support: Optional[int] = None,
    canonical_mode: Optional[str] = None,   # all | canonical | non_canonical
    annotated_mode: Optional[str] = None,   # all | annotated | novel
    bins: int = 500,
    level: str = "fine",
    max_junctions: Optional[int] = None,
):
    """
    Parse a STAR SJ.out.tab file and return splice junctions overlapping [start, end).
    SJ.out.tab columns: chrom, intron_start(1-based), intron_end(1-based), strand, intron_motif,
                         annotated, n_unique_mapped, n_multi_mapped, max_overhang.
    """
    def _run():
        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"SJ file not found: {path}")

        applied = _resolve_splice_applied_settings(
            path=path,
            track_id=track_id,
            min_reads=min_reads,
            min_support=min_support,
            canonical_mode=canonical_mode,
            annotated_mode=annotated_mode,
            max_junctions=max_junctions,
        )

        available_chroms = _get_sj_available_chroms(p)
        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
        local_annotated_pairs = _load_splice_local_annotation_pairs(genome, resolved_chrom, chrom)

        try:
            junctions = _collect_splice_junctions(
                sj_path=p,
                resolved_chrom=resolved_chrom,
                start=start,
                end=end,
                applied=applied,
                local_annotated_pairs=local_annotated_pairs,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"SJ parse error: {e}")

        if level == "fine":
            return {
                "level": level,
                "chrom": resolved_chrom,
                "start": start,
                "end": end,
                "junctions": junctions,
                "applied_filters": applied,
            }

        # Density: count junctions per bin, weighted by read count
        span = max(1, end - start)
        density = [0.0] * bins
        for jn in junctions:
            mid = (jn["start"] + jn["end"]) / 2
            idx = int((mid - start) / span * bins)
            idx = max(0, min(bins - 1, idx))
            density[idx] += jn["n_total"]
        max_count = max(density) if density else 0
        return {
            "level": level,
            "chrom": resolved_chrom,
            "start": start,
            "end": end,
            "bins": density,
            "max_count": max_count,
            "applied_filters": applied,
        }

    return await run_in_threadpool(_run)


@router.post("/api/browse/splice_junctions/block_tiles")
async def browse_splice_junctions_block_tiles(payload: SpliceBlockTilesRequest):
    def _run():
        if not payload.tiles:
            raise HTTPException(status_code=400, detail="tiles must not be empty")

        path = str(payload.path or "").strip()
        chrom_req = str(payload.chrom or "").strip()
        genome = str(payload.genome or "reference").strip() or "reference"
        if not path:
            raise HTTPException(status_code=400, detail="path is required")
        if not chrom_req:
            raise HTTPException(status_code=400, detail="chrom is required")

        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"SJ file not found: {path}")

        applied = _resolve_splice_applied_settings(
            path=path,
            track_id=payload.track_id,
            min_reads=int(payload.min_reads),
            min_support=payload.min_support,
            canonical_mode=payload.canonical_mode,
            annotated_mode=payload.annotated_mode,
            max_junctions=payload.max_junctions,
        )

        req_start = min(max(0, int(tile.start)) for tile in payload.tiles)
        req_end = max(max(int(tile.start) + 1, int(tile.end)) for tile in payload.tiles)

        available_chroms = _get_sj_available_chroms(p)
        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom_req, available_chroms, genome=genome)
        local_annotated_pairs = _load_splice_local_annotation_pairs(genome, resolved_chrom, chrom_req)
        try:
            junctions = _collect_splice_junctions(
                sj_path=p,
                resolved_chrom=resolved_chrom,
                start=req_start,
                end=req_end,
                applied=applied,
                local_annotated_pairs=local_annotated_pairs,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"SJ parse error: {e}")

        out_tiles: List[Dict[str, Any]] = []
        for tile in payload.tiles:
            tile_start = max(0, int(tile.start))
            tile_end = max(tile_start + 1, int(tile.end))
            block_bp = routes.tracks._to_int_or_default(tile.block_bp, 5000, minimum=50, maximum=10_000_000)
            block_spans, painted_bp = _build_splice_block_spans_from_junctions(
                junctions=junctions,
                tile_start=tile_start,
                tile_end=tile_end,
                block_bp=block_bp,
            )
            tile_span = max(1, tile_end - tile_start)
            out_tiles.append({
                "start": tile_start,
                "end": tile_end,
                "level_id": str(tile.level_id or "L0"),
                "block_bp": int(block_bp),
                "block_spans": block_spans,
                "has_data": bool(block_spans),
                "coverage": float(max(0.0, min(1.0, painted_bp / tile_span))),
            })

        return {
            "chrom": resolved_chrom,
            "tiles": out_tiles,
            "applied_filters": applied,
        }

    return await run_in_threadpool(_run)
