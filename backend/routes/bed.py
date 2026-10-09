"""BED and bigBed tracks: BED line and bigBed record parsing (with the per-file autoSql
schema cache), density bins, block and feature tiles for the browser's level-of-detail
rendering, and the /api/browse/bed and bigBed tile endpoints.
"""

import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None

import genome_context
import routes.tracks
from bed_index import get_plain_bed_index, is_gff_path, is_plain_bed_path, open_plain_bed

router = APIRouter()


class BigBedBlockTileRequest(BaseModel):
    start: int
    end: int
    level_id: str = "L0"
    block_bp: int = 5000


class BigBedBlockTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[BigBedBlockTileRequest]
    genome: str = "reference"
    # Per-block feature counts, for drawing a density histogram rather than spans.
    include_counts: bool = False
    # "transcripts": read a GFF/GTF as gene models rather than one interval per line.
    feature_model: str = ""


class BigBedFeatureTileRequest(BaseModel):
    start: int
    end: int
    level_id: str = "detail"
    max_features: int = 3000


class BigBedFeatureTilesRequest(BaseModel):
    path: str
    chrom: str
    tiles: List[BigBedFeatureTileRequest]
    genome: str = "reference"
    max_features_per_tile: int = 3000
    feature_model: str = ""


# ── BED endpoint ─────────────────────────────────────────────────────────────

def _parse_bed_line(line: str) -> Optional[Dict]:
    """Parse one BED line into a dict. Returns None for comment/header/empty lines."""
    line = line.strip()
    if not line or line.startswith("#") or line.startswith("track") or line.startswith("browser"):
        return None
    cols = line.split("\t")
    if len(cols) < 3:
        return None
    try:
        chrom = cols[0]
        start = int(cols[1])  # 0-based
        end = int(cols[2])    # exclusive
    except ValueError:
        return None
    name = cols[3] if len(cols) > 3 else ""
    score = cols[4] if len(cols) > 4 else "0"
    strand = cols[5] if len(cols) > 5 else "."
    color = cols[8] if len(cols) > 8 else ""
    return {"chrom": chrom, "start": start, "end": end, "name": name, "score": score, "strand": strand, "color": color}


def _bed_density_bins(intervals: List[Dict], start: int, end: int, bins: int) -> List[int]:
    span = max(1, end - start)
    counts = [0] * bins
    for iv in intervals:
        i1 = int((iv["start"] - start) / span * bins)
        i2 = int((iv["end"] - start) / span * bins)
        i1 = max(0, min(bins - 1, i1))
        i2 = max(i1, min(bins - 1, i2))
        for i in range(i1, i2 + 1):
            counts[i] += 1
    return counts


def _is_bigbed_path(path: Path) -> bool:
    lower = str(path.name or "").strip().lower()
    return lower.endswith(".bb") or lower.endswith(".bigbed")


_BIGBED_SCHEMA_CACHE: Dict[str, Dict[str, Any]] = {}


_BIGBED_SCHEMA_CACHE_LOCK = threading.Lock()


def _bigbed_path_signature(path: Path) -> Tuple[int, int]:
    try:
        st = path.stat()
        return (int(st.st_mtime_ns), int(st.st_size))
    except Exception:
        return (0, 0)


def _canonical_bigbed_field_name(token: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(token or "").strip().lower())


def _parse_bigbed_sql_field_order(sql_raw: Any) -> List[str]:
    if sql_raw is None:
        return []
    if isinstance(sql_raw, (bytes, bytearray)):
        text = sql_raw.decode("utf-8", errors="replace")
    else:
        text = str(sql_raw)
    if not text.strip():
        return []
    start = text.find("(")
    end = text.rfind(")")
    if start < 0 or end <= start:
        return []
    body = text[start + 1:end]
    out: List[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        prefix = line.split('"', 1)[0].strip()
        if ";" not in prefix:
            continue
        token = prefix.split(";", 1)[0].strip()
        if not token:
            continue
        field = re.split(r"\s+", token)[-1].strip()
        if field:
            out.append(field)
    return out


def _get_bigbed_schema_info(path: Path, bb: Any) -> Dict[str, Any]:
    cache_key = str(path.resolve())
    sig = _bigbed_path_signature(path)
    with _BIGBED_SCHEMA_CACHE_LOCK:
        cached = _BIGBED_SCHEMA_CACHE.get(cache_key)
        if cached and cached.get("sig") == sig:
            return cached

    try:
        sql_raw = bb.SQL()
    except Exception:
        sql_raw = None
    field_order = _parse_bigbed_sql_field_order(sql_raw)
    rest_index: Dict[str, int] = {}
    for idx, field_name in enumerate(field_order):
        if idx < 3:
            continue
        canon = _canonical_bigbed_field_name(field_name)
        if canon and canon not in rest_index:
            rest_index[canon] = idx - 3
    parsed = {
        "sig": sig,
        "field_order": field_order,
        "rest_index": rest_index,
    }
    with _BIGBED_SCHEMA_CACHE_LOCK:
        _BIGBED_SCHEMA_CACHE[cache_key] = parsed
    return parsed


def _parse_csv_ints(value: Any) -> List[int]:
    token = str(value or "").strip().strip(",")
    if not token:
        return []
    out: List[int] = []
    for part in token.split(","):
        p = part.strip()
        if not p:
            continue
        try:
            out.append(int(p))
        except Exception:
            return []
    return out


def _parse_bigbed_rest(
    rest: Any,
    schema_info: Optional[Dict[str, Any]] = None,
    chrom_start: Optional[int] = None,
    chrom_end: Optional[int] = None,
) -> Dict[str, Any]:
    token = rest.decode("utf-8", errors="replace") if isinstance(rest, (bytes, bytearray)) else str(rest or "")
    cols = token.split("\t") if token else []
    rest_index = schema_info.get("rest_index") if isinstance(schema_info, dict) else None
    rest_index = rest_index if isinstance(rest_index, dict) else {}
    field_order = schema_info.get("field_order") if isinstance(schema_info, dict) else None
    field_order = field_order if isinstance(field_order, list) else []
    allow_positional_bed_fallback = not field_order

    def _find_col(field_names: List[str], fallback_idx: Optional[int] = None) -> str:
        for name in field_names:
            idx = rest_index.get(_canonical_bigbed_field_name(name))
            if idx is None:
                continue
            if 0 <= idx < len(cols):
                return cols[idx]
        if allow_positional_bed_fallback and fallback_idx is not None and 0 <= fallback_idx < len(cols):
            return cols[fallback_idx]
        return ""

    out: Dict[str, Any] = {
        "name": "",
        "score": "0",
        "strand": ".",
        "color": "",
        "itemRgb": "",
        "thick_start": None,
        "thick_end": None,
        "block_count": None,
        "block_sizes": "",
        "block_starts": "",
        "extra_fields": [],
        "extra_field_names": [],
        "extra_fields_map": {},
        "has_name": False,
        "has_score": False,
        "has_strand": False,
        "render_kind": "interval",
        "structure_valid": False,
        "exon_blocks": [],
        "cds_blocks": [],
    }
    raw_name = _find_col(["name"], fallback_idx=0)
    raw_score = _find_col(["score"], fallback_idx=1)
    raw_strand = _find_col(["strand"], fallback_idx=2)
    raw_thick_start = _find_col(["thickStart", "thick_start"], fallback_idx=3)
    raw_thick_end = _find_col(["thickEnd", "thick_end"], fallback_idx=4)
    raw_color = _find_col(["itemRgb", "item_rgb", "reserved", "color"], fallback_idx=5)
    raw_block_count = _find_col(["blockCount", "block_count"], fallback_idx=6)
    raw_block_sizes = _find_col(["blockSizes", "block_sizes"], fallback_idx=7)
    raw_block_starts = _find_col(["blockStarts", "block_starts", "chromStarts", "chrom_starts"], fallback_idx=8)

    if raw_name:
        out["name"] = raw_name
        out["has_name"] = True
    if raw_score:
        out["score"] = raw_score
        out["has_score"] = True
    if raw_strand:
        out["strand"] = raw_strand
        out["has_strand"] = True
    try:
        out["thick_start"] = int(raw_thick_start) if str(raw_thick_start).strip() else None
    except Exception:
        out["thick_start"] = None
    try:
        out["thick_end"] = int(raw_thick_end) if str(raw_thick_end).strip() else None
    except Exception:
        out["thick_end"] = None
    if raw_color:
        out["color"] = raw_color
        out["itemRgb"] = raw_color
    try:
        out["block_count"] = int(raw_block_count) if str(raw_block_count).strip() else None
    except Exception:
        out["block_count"] = None
    if raw_block_sizes:
        out["block_sizes"] = raw_block_sizes
    if raw_block_starts:
        out["block_starts"] = raw_block_starts

    known_indexes: Set[int] = set()
    for canon_name in (
        "name",
        "score",
        "strand",
        "thickstart",
        "thickend",
        "itemrgb",
        "reserved",
        "color",
        "blockcount",
        "blocksizes",
        "blockstarts",
        "chromstarts",
    ):
        idx = rest_index.get(canon_name)
        if isinstance(idx, int) and 0 <= idx < len(cols):
            known_indexes.add(idx)
    if not rest_index:
        known_indexes = {i for i in range(min(9, len(cols)))}
    extra_fields: List[str] = []
    extra_field_names: List[str] = []
    extra_fields_map: Dict[str, str] = {}
    for i in range(len(cols)):
        value = str(cols[i]).strip()
        if i in known_indexes or not value:
            continue
        field_name = str(field_order[i + 3] if i + 3 < len(field_order) else f"extra_{i + 1}").strip()
        extra_fields.append(value)
        extra_field_names.append(field_name)
        if field_name:
            extra_fields_map[field_name] = value
    out["extra_fields"] = extra_fields
    out["extra_field_names"] = extra_field_names
    out["extra_fields_map"] = extra_fields_map

    block_count = out["block_count"]
    block_sizes = _parse_csv_ints(out["block_sizes"])
    block_starts = _parse_csv_ints(out["block_starts"])
    if block_count is None and block_sizes and len(block_sizes) == len(block_starts):
        block_count = len(block_sizes)

    exon_blocks: List[Dict[str, int]] = []
    structure_valid = False
    if (
        isinstance(block_count, int)
        and block_count > 0
        and len(block_sizes) == block_count
        and len(block_starts) == block_count
        and chrom_start is not None
    ):
        cs = int(chrom_start)
        ce = int(chrom_end) if chrom_end is not None else None
        valid = True
        for size, rel_start in zip(block_sizes, block_starts):
            if size <= 0:
                valid = False
                break
            b_start = cs + int(rel_start)
            b_end = b_start + int(size)
            if ce is not None:
                b_start = max(cs, b_start)
                b_end = min(ce, b_end)
            if b_end <= b_start:
                continue
            exon_blocks.append({"start": int(b_start), "end": int(b_end)})
        if valid and exon_blocks:
            structure_valid = True

    cds_blocks: List[Dict[str, int]] = []
    thick_start = out["thick_start"]
    thick_end = out["thick_end"]
    if structure_valid and thick_start is not None and thick_end is not None and int(thick_end) > int(thick_start):
        ts = int(thick_start)
        te = int(thick_end)
        for block in exon_blocks:
            cds_start = max(int(block["start"]), ts)
            cds_end = min(int(block["end"]), te)
            if cds_end > cds_start:
                cds_blocks.append({"start": int(cds_start), "end": int(cds_end)})

    out["structure_valid"] = structure_valid
    out["render_kind"] = "transcript" if structure_valid else "interval"
    out["exon_blocks"] = exon_blocks
    out["cds_blocks"] = cds_blocks
    return out


def _bigbed_score_value(score: Any) -> float:
    try:
        return float(score)
    except Exception:
        return 0.0


def _parse_item_rgb(color_value: Any) -> Optional[Tuple[int, int, int]]:
    token = str(color_value or "").strip()
    if not token:
        return None
    parts = token.split(",")
    if len(parts) != 3:
        return None
    try:
        rgb = tuple(max(0, min(255, int(p))) for p in parts)
    except Exception:
        return None
    if len(rgb) != 3:
        return None
    return rgb  # type: ignore[return-value]


@router.get("/api/browse/bed")
async def browse_bed(
    path: str,
    chrom: str,
    start: int,
    end: int,
    genome: str = "reference",
    bins: int = 500,
    level: str = "fine",
    max_intervals: int = 10000,
):
    """
    Query a BED/BigBed file for intervals overlapping [start, end).
    Performs a linear scan (BED is not always indexed). For large files a tabix
    index will be used if present (.tbi alongside the .bed.gz).
    """
    def _run():
        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"BED not found: {path}")

        intervals: List[Dict] = []
        resolved_chrom = str(chrom or "")

        if _is_bigbed_path(p):
            if pyBigWig is None:
                raise HTTPException(
                    status_code=503,
                    detail="BigBed support is unavailable. Install pyBigWig in the backend environment.",
                )
            try:
                bb = pyBigWig.open(str(p))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Failed to open BigBed: {e}")
            if bb is None:
                raise HTTPException(status_code=400, detail="Failed to open BigBed file.")
            try:
                chrom_sizes = bb.chroms() or {}
                available_chroms = list(chrom_sizes.keys())
                resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
                schema_info = _get_bigbed_schema_info(p, bb)
                if resolved_chrom not in chrom_sizes:
                    if level == "fine":
                        return {
                            "level": level,
                            "start": start,
                            "end": end,
                            "intervals": [],
                            "features": [],
                            "resolved_chrom": None,
                            "has_data": False,
                            "detail": "Chromosome not present in BigBed file.",
                        }
                    return {
                        "level": level,
                        "start": start,
                        "end": end,
                        "bins": [0] * bins,
                        "max_count": 0,
                        "resolved_chrom": None,
                        "has_data": False,
                        "detail": "Chromosome not present in BigBed file.",
                    }

                chrom_len = int(chrom_sizes.get(resolved_chrom, 0) or 0)
                q_start = max(0, int(start))
                q_end = min(int(end), chrom_len) if chrom_len > 0 else int(end)
                if q_end > q_start:
                    rows = bb.entries(resolved_chrom, q_start, q_end) or []
                    for row in rows:
                        if not isinstance(row, (tuple, list)) or len(row) < 2:
                            continue
                        iv_start = int(row[0])
                        iv_end = int(row[1])
                        if iv_end < q_start or iv_start > q_end:
                            continue
                        rec = {
                            "chrom": resolved_chrom,
                            "start": iv_start,
                            "end": iv_end,
                            "name": "",
                            "score": "0",
                            "strand": ".",
                            "color": "",
                        }
                        if len(row) > 2:
                            rec.update(
                                _parse_bigbed_rest(
                                    row[2],
                                    schema_info=schema_info,
                                    chrom_start=iv_start,
                                    chrom_end=iv_end,
                                )
                            )
                        intervals.append(rec)
                        if len(intervals) >= max_intervals:
                            break
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"BigBed read error: {e}")
            finally:
                try:
                    bb.close()
                except Exception:
                    pass

        else:
            # Try tabix if available
            tbi = Path(str(path) + ".tbi")
            if tbi.exists():
                try:
                    import pysam  # type: ignore
                    tbx = pysam.TabixFile(str(p))
                    try:
                        available_chroms = list(tbx.contigs or [])
                        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, available_chroms, genome=genome)
                        if resolved_chrom in set(available_chroms):
                            for row in tbx.fetch(resolved_chrom, max(0, start - 1), end):
                                rec = _parse_bed_line(row)
                                if rec and len(intervals) < max_intervals:
                                    intervals.append(rec)
                    finally:
                        tbx.close()
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"BED tabix query error: {e}")
            else:
                # The file is read once into a cached in-memory index, not scanned per request.
                try:
                    index = get_plain_bed_index(p)
                    known_chroms = sorted(index.chroms().keys())
                    if known_chroms:
                        resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom, known_chroms, genome=genome)
                        for f_start, f_end, rest in index.entries(resolved_chrom, max(0, start), end):
                            rec = _parse_bed_line(f"{resolved_chrom}\t{f_start}\t{f_end}\t{rest}")
                            if rec:
                                intervals.append(rec)
                            if len(intervals) >= max_intervals:
                                break
                    else:
                        intervals = []
                except Exception as e:
                    raise HTTPException(status_code=500, detail=f"BED read error: {e}")

        if level == "fine":
            return {
                "level": level,
                "start": start,
                "end": end,
                "intervals": intervals,
                "features": intervals,
                "resolved_chrom": resolved_chrom,
                "has_data": len(intervals) > 0,
            }
        else:
            density = _bed_density_bins(intervals, start, end, bins)
            return {
                "level": level,
                "start": start,
                "end": end,
                "bins": density,
                "max_count": max(density) if density else 0,
                "resolved_chrom": resolved_chrom,
                "has_data": any(v > 0 for v in density),
            }

    return await run_in_threadpool(_run)


def _open_bed_tile_source(p: Path, feature_model: str = "") -> Any:
    """A BigBed handle, or a plain BED or GFF/GTF file answering the same calls.

    Plain BED and GFF go through an in-memory index (or their tabix index) built once
    per file, so the tile endpoints serve every interval format with the same tiling
    and summaries.
    """
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"Track file not found: {p}")
    if is_plain_bed_path(p) or is_gff_path(p):
        try:
            return open_plain_bed(p, feature_model)
        except Exception as e:
            kind = "GFF" if is_gff_path(p) else "BED"
            raise HTTPException(status_code=400, detail=f"Failed to read {kind}: {e}")
    if not _is_bigbed_path(p):
        raise HTTPException(status_code=400, detail="path is not a BED, GFF or BigBed file")
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigBed support is unavailable. Install pyBigWig.")
    try:
        bb = pyBigWig.open(str(p))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to open BigBed: {e}")
    if bb is None:
        raise HTTPException(status_code=400, detail="Failed to open BigBed file.")
    return bb


def _bed_block_counts(
    features: List[Dict[str, Any]],
    tile_start: int,
    tile_end: int,
    block_bp: int,
) -> List[int]:
    """How many features overlap each block of a tile."""
    span = max(1, tile_end - tile_start)
    block_size = max(1, int(block_bp))
    slot_count = max(1, (span + block_size - 1) // block_size)
    counts = [0] * slot_count
    for feature in features:
        ov_start = max(tile_start, int(feature.get("start", 0) or 0))
        ov_end = min(tile_end, int(feature.get("end", 0) or 0))
        if ov_end <= ov_start:
            continue
        b0 = (ov_start - tile_start) // block_size
        b1 = min(slot_count - 1, (ov_end - 1 - tile_start) // block_size)
        for idx in range(b0, b1 + 1):
            counts[idx] += 1
    return counts


def _build_bigbed_block_spans_from_features(
    features: List[Dict[str, Any]],
    tile_start: int,
    tile_end: int,
    block_bp: int,
) -> Tuple[List[Dict[str, Any]], int]:
    span = max(1, tile_end - tile_start)
    block_size = max(1, int(block_bp))
    slot_count = max(1, (span + block_size - 1) // block_size)
    active = [0] * slot_count
    feature_counts = [0] * slot_count
    max_score = [0.0] * slot_count
    color_hint = [""] * slot_count

    for feature in features:
        f_start = int(feature.get("start", 0) or 0)
        f_end = int(feature.get("end", 0) or 0)
        if f_end <= tile_start or f_start >= tile_end:
            continue
        ov_start = max(tile_start, f_start)
        ov_end = min(tile_end, f_end)
        if ov_end <= ov_start:
            continue
        b0 = max(0, min(slot_count - 1, (ov_start - tile_start) // block_size))
        b1 = max(0, min(slot_count - 1, (max(ov_start, ov_end - 1) - tile_start) // block_size))
        score = _bigbed_score_value(feature.get("score"))
        color = str(feature.get("itemRgb") or feature.get("color") or "").strip()
        for idx in range(b0, b1 + 1):
            active[idx] = 1
            feature_counts[idx] += 1
            if score >= max_score[idx]:
                max_score[idx] = score
                if color:
                    color_hint[idx] = color

    spans: List[Dict[str, Any]] = []
    painted_bp = 0
    idx = 0
    while idx < slot_count:
        if active[idx] == 0:
            idx += 1
            continue
        run_start = idx
        run_max_score = max_score[idx]
        run_max_count = feature_counts[idx]
        run_color = color_hint[idx]
        idx += 1
        while idx < slot_count and active[idx] == 1:
            run_max_score = max(run_max_score, max_score[idx])
            run_max_count = max(run_max_count, feature_counts[idx])
            if not run_color and color_hint[idx]:
                run_color = color_hint[idx]
            idx += 1
        run_end = idx - 1
        start_bp = tile_start + run_start * block_size
        end_bp = min(tile_end, tile_start + (run_end + 1) * block_size)
        if end_bp > start_bp:
            spans.append({
                "start": int(start_bp),
                "end": int(end_bp),
                "feature_count": int(run_max_count),
                "max_score": float(run_max_score),
                "color_hint": run_color,
            })
            painted_bp += (end_bp - start_bp)
    return spans, painted_bp


def _select_bigbed_tile_entries(
    bb: Any,
    resolved_chrom: str,
    tile_start: int,
    tile_end: int,
    max_features: int,
    schema_info: Optional[Dict[str, Any]] = None,
) -> Tuple[List[Dict[str, Any]], bool]:
    rows = bb.entries(resolved_chrom, tile_start, tile_end) or []
    features: List[Dict[str, Any]] = []
    truncated = False
    for row in rows:
        if not isinstance(row, (tuple, list)) or len(row) < 2:
            continue
        try:
            f_start = int(row[0])
            f_end = int(row[1])
        except Exception:
            continue
        if f_end <= tile_start or f_start >= tile_end:
            continue
        rec: Dict[str, Any] = {
            "chrom": resolved_chrom,
            "start": f_start,
            "end": f_end,
            "name": "",
            "score": "0",
            "strand": ".",
            "color": "",
            "itemRgb": "",
            "thick_start": None,
            "thick_end": None,
            "block_count": None,
            "block_sizes": "",
            "block_starts": "",
            "extra_fields": [],
        }
        if len(row) > 2:
            rec.update(
                _parse_bigbed_rest(
                    row[2],
                    schema_info=schema_info,
                    chrom_start=f_start,
                    chrom_end=f_end,
                )
            )
        features.append(rec)
        if len(features) >= max_features:
            truncated = True
            break

    features.sort(
        key=lambda f: (
            int(f.get("start", 0) or 0),
            int(f.get("end", 0) or 0),
            str(f.get("name") or ""),
            -_bigbed_score_value(f.get("score")),
            str(f.get("strand") or "."),
        )
    )
    return features, truncated


def _select_bigbed_block_entries(
    bb: Any,
    resolved_chrom: str,
    tile_start: int,
    tile_end: int,
    max_features: int,
    schema_info: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    """Just what a summary block needs from each row: its span, score and colour.

    The full row parse (names, blocks, extra fields) cost ~20µs a row, which a whole-
    chromosome summary of a dense file — 40k regulatory features — turned into most of
    a second, all of it thrown away when the rows were folded into blocks.
    """
    rest_index = (schema_info or {}).get("rest_index") or {}
    score_idx = rest_index.get("score", 1 if not rest_index else None)
    colour_idx = rest_index.get("itemrgb", rest_index.get("reserved", 5 if not rest_index else None))
    out: List[Dict[str, Any]] = []
    for row in bb.entries(resolved_chrom, tile_start, tile_end) or []:
        if not isinstance(row, (tuple, list)) or len(row) < 2:
            continue
        try:
            f_start = int(row[0])
            f_end = int(row[1])
        except Exception:
            continue
        if f_end <= tile_start or f_start >= tile_end:
            continue
        score = "0"
        colour = ""
        if len(row) > 2 and (score_idx is not None or colour_idx is not None):
            rest = row[2]
            cols = (rest.decode("utf-8", errors="replace") if isinstance(rest, (bytes, bytearray)) else str(rest or "")).split("\t")
            if score_idx is not None and score_idx < len(cols) and cols[score_idx]:
                score = cols[score_idx]
            if colour_idx is not None and colour_idx < len(cols):
                colour = cols[colour_idx]
        out.append({"start": f_start, "end": f_end, "score": score, "itemRgb": colour})
        if len(out) >= max_features:
            break
    return out


@router.post("/api/browse/bigbed/block_tiles")
async def browse_bigbed_block_tiles(payload: BigBedBlockTilesRequest):
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
        bb = _open_bed_tile_source(p, str(payload.feature_model or ""))

        try:
            chrom_sizes = bb.chroms() or {}
            available = list(chrom_sizes.keys())
            resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom_req, available, genome=genome)
            schema_info = _get_bigbed_schema_info(p, bb)
            if resolved_chrom not in chrom_sizes:
                return {
                    "chrom": chrom_req,
                    "resolved_chrom": None,
                    "tiles": [
                        {
                            "start": max(0, int(tile.start)),
                            "end": max(max(0, int(tile.start)) + 1, int(tile.end)),
                            "level_id": str(tile.level_id or "L0"),
                            "block_bp": int(max(1, int(tile.block_bp))),
                            "block_spans": [],
                            "has_data": False,
                            "coverage": 0.0,
                        }
                        for tile in payload.tiles
                    ],
                }

            chrom_len = int(chrom_sizes.get(resolved_chrom, 0) or 0)
            out_tiles: List[Dict[str, Any]] = []
            for tile in payload.tiles:
                tile_start = max(0, int(tile.start))
                tile_end = max(tile_start + 1, int(tile.end))
                tile_end = min(tile_end, chrom_len) if chrom_len > 0 else tile_end
                if tile_end <= tile_start:
                    out_tiles.append({
                        "start": tile_start,
                        "end": tile_end,
                        "level_id": str(tile.level_id or "L0"),
                        "block_bp": int(max(1, int(tile.block_bp))),
                        "block_spans": [],
                        "has_data": False,
                        "coverage": 0.0,
                    })
                    continue

                # Summary mode intentionally tolerates high row counts; cap to avoid pathological stalls.
                features = _select_bigbed_block_entries(
                    bb=bb,
                    resolved_chrom=resolved_chrom,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    max_features=250_000,
                    schema_info=schema_info,
                )
                block_bp = routes.tracks._to_int_or_default(tile.block_bp, 5000, minimum=50, maximum=10_000_000)
                block_spans, painted_bp = _build_bigbed_block_spans_from_features(
                    features=features,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    block_bp=block_bp,
                )
                tile_span = max(1, tile_end - tile_start)
                out_tile = {
                    "start": tile_start,
                    "end": tile_end,
                    "level_id": str(tile.level_id or "L0"),
                    "block_bp": int(block_bp),
                    "block_spans": block_spans,
                    "has_data": bool(block_spans),
                    "coverage": float(max(0.0, min(1.0, painted_bp / tile_span))),
                }
                if payload.include_counts:
                    out_tile["counts"] = _bed_block_counts(features, tile_start, tile_end, block_bp)
                out_tiles.append(out_tile)

            return {"chrom": resolved_chrom, "resolved_chrom": resolved_chrom, "tiles": out_tiles}
        finally:
            try:
                bb.close()
            except Exception:
                pass

    return await run_in_threadpool(_run)


@router.post("/api/browse/bigbed/feature_tiles")
async def browse_bigbed_feature_tiles(payload: BigBedFeatureTilesRequest):
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
        bb = _open_bed_tile_source(p, str(payload.feature_model or ""))

        try:
            chrom_sizes = bb.chroms() or {}
            available = list(chrom_sizes.keys())
            resolved_chrom = genome_context._resolve_track_chrom_with_aliases(chrom_req, available, genome=genome)
            schema_info = _get_bigbed_schema_info(p, bb)
            if resolved_chrom not in chrom_sizes:
                return {
                    "chrom": chrom_req,
                    "resolved_chrom": None,
                    "tiles": [
                        {
                            "start": max(0, int(tile.start)),
                            "end": max(max(0, int(tile.start)) + 1, int(tile.end)),
                            "level_id": str(tile.level_id or "detail"),
                            "features": [],
                            "has_data": False,
                            "coverage": 0.0,
                            "truncated": False,
                        }
                        for tile in payload.tiles
                    ],
                }

            chrom_len = int(chrom_sizes.get(resolved_chrom, 0) or 0)
            request_limit = routes.tracks._to_int_or_default(payload.max_features_per_tile, 3000, minimum=100, maximum=50_000)
            out_tiles: List[Dict[str, Any]] = []

            for tile in payload.tiles:
                tile_start = max(0, int(tile.start))
                tile_end = max(tile_start + 1, int(tile.end))
                tile_end = min(tile_end, chrom_len) if chrom_len > 0 else tile_end
                if tile_end <= tile_start:
                    out_tiles.append({
                        "start": tile_start,
                        "end": tile_end,
                        "level_id": str(tile.level_id or "detail"),
                        "features": [],
                        "has_data": False,
                        "coverage": 0.0,
                        "truncated": False,
                    })
                    continue

                max_features = routes.tracks._to_int_or_default(tile.max_features, request_limit, minimum=100, maximum=50_000)
                features, truncated = _select_bigbed_tile_entries(
                    bb=bb,
                    resolved_chrom=resolved_chrom,
                    tile_start=tile_start,
                    tile_end=tile_end,
                    max_features=max_features,
                    schema_info=schema_info,
                )
                covered_bp = 0
                if features:
                    sorted_feats = sorted(features, key=lambda f: (int(f.get("start", 0) or 0), int(f.get("end", 0) or 0)))
                    run_start = int(sorted_feats[0].get("start", 0) or 0)
                    run_end = int(sorted_feats[0].get("end", 0) or 0)
                    for feature in sorted_feats[1:]:
                        s = int(feature.get("start", 0) or 0)
                        e = int(feature.get("end", 0) or 0)
                        if s <= run_end:
                            run_end = max(run_end, e)
                        else:
                            covered_bp += max(0, run_end - run_start)
                            run_start, run_end = s, e
                    covered_bp += max(0, run_end - run_start)
                tile_span = max(1, tile_end - tile_start)
                out_tiles.append({
                    "start": tile_start,
                    "end": tile_end,
                    "level_id": str(tile.level_id or "detail"),
                    "features": features,
                    "has_data": bool(features),
                    "coverage": float(max(0.0, min(1.0, covered_bp / tile_span))),
                    "truncated": bool(truncated),
                })

            return {"chrom": resolved_chrom, "resolved_chrom": resolved_chrom, "tiles": out_tiles}
        finally:
            try:
                bb.close()
            except Exception:
                pass

    return await run_in_threadpool(_run)
