"""BigWig tracks: binned means over a window, the zone scale (shared per file or per
track) with its cache, and the /api/browse/bigwig endpoints including the batched tile
request the browser uses.
"""

import math
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

try:
    import pyBigWig  # type: ignore
except Exception:
    pyBigWig = None

import genome_context

router = APIRouter()


def _bigwig_binned_means(
    bw: Any,
    chrom: str,
    start: int,
    end: int,
    bins: int,
    chrom_len: int,
    exact: bool = False,
) -> List[Optional[float]]:
    """Mean signal in `bins` equal bins spanning [start, end), None past the chromosome.

    Callers place bin i at start + i * (end - start) / bins, so the bins must keep that
    width even where the range runs off the end of the chromosome. Asking pyBigWig for
    `bins` bins over the clipped range instead squeezed them into the part that exists,
    and the browser then drew the last tile of every chromosome stretched to the right.
    """
    out: List[Optional[float]] = [None] * bins
    q_start = max(0, start)
    q_end = min(end, chrom_len) if chrom_len > 0 else end
    if bins <= 0 or end <= start or q_end <= q_start:
        return out

    bin_size = (end - start) / bins
    edge = lambda index: start + int(round(index * bin_size))  # noqa: E731
    # Bins wholly inside the chromosome, then the part-bins at either edge of it.
    lo = math.ceil((q_start - start) / bin_size)
    hi = math.floor((q_end - start) / bin_size)
    spans: List[Tuple[int, int, int, int]] = []  # (first bin, bin count, query start, query end)
    if hi > lo:
        spans.append((lo, hi - lo, edge(lo), edge(hi)))
    if lo > 0 and q_start < edge(lo):
        spans.append((lo - 1, 1, q_start, min(edge(lo), q_end)))
    if hi < bins and edge(hi) < q_end and hi >= lo:
        spans.append((hi, 1, edge(hi), q_end))

    for first, count, q0, q1 in spans:
        if q1 <= q0:
            continue
        raw = bw.stats(chrom, q0, q1, type="mean", nBins=count, exact=exact) or []
        for offset, value in enumerate(raw[:count]):
            if value is None or (isinstance(value, float) and math.isnan(value)):
                continue
            out[first + offset] = float(value)
    return out


# Zone edges for a zoned heatmap scaled to the file: the 50th, 90th, 99th and 99.9th
# percentile of its peak heights, sampled as the maximum of ~50 kb bins across every
# chromosome. Percentiles rather than the maximum, because one spike (a 564k pile-up in
# an RNA-seq file) would otherwise flatten everything else. Cached per file version.
_BIGWIG_ZONE_SCALE_CACHE: Dict[str, Tuple[Tuple[int, int], Dict[str, Any]]] = {}


_BIGWIG_ZONE_SCALE_LOCK = threading.Lock()


_BIGWIG_ZONE_QUANTILES = (0.5, 0.9, 0.99, 0.999)


def _bigwig_zone_edges(bin_maxima: List[float]) -> List[float]:
    """Four increasing zone edges from sampled peak heights."""
    values = sorted(v for v in bin_maxima if v is not None and math.isfinite(v) and v > 0)
    if not values:
        return []
    edges: List[float] = []
    for q in _BIGWIG_ZONE_QUANTILES:
        edge = float(values[min(len(values) - 1, int(q * len(values)))])
        # Strictly increasing, so no zone is empty even where the percentiles coincide.
        if edges and edge <= edges[-1]:
            edge = edges[-1] * 1.05 if edges[-1] > 0 else 1e-6
        edges.append(edge)
    return edges


def _bigwig_peak_samples(p: Path) -> Tuple[List[float], float]:
    """A file's peak heights (max of each ~50 kb bin) and its maximum, cached per version."""
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"BigWig not found: {p}")
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigWig support is unavailable. Install pyBigWig.")
    st = p.stat()
    sig = (int(st.st_mtime_ns), int(st.st_size))
    key = str(p.resolve())
    with _BIGWIG_ZONE_SCALE_LOCK:
        cached = _BIGWIG_ZONE_SCALE_CACHE.get(key)
        if cached and cached[0] == sig:
            return cached[1]
    bw = pyBigWig.open(str(p))
    if bw is None:
        raise HTTPException(status_code=400, detail="Failed to open BigWig file.")
    try:
        samples: List[float] = []
        for chrom, length in (bw.chroms() or {}).items():
            bins = max(1, min(2000, int(length) // 50_000))
            try:
                samples.extend(v for v in (bw.stats(chrom, 0, int(length), type="max", nBins=bins) or []) if v)
            except Exception:
                continue
        header = bw.header() or {}
    finally:
        bw.close()
    result = (samples, float(header.get("maxVal") or 0.0))
    with _BIGWIG_ZONE_SCALE_LOCK:
        _BIGWIG_ZONE_SCALE_CACHE[key] = (sig, result)
    return result


def _bigwig_zone_scale_for(paths: List[str]) -> Dict[str, Any]:
    """Zone edges from the peaks of one file, or of several pooled, so they share a scale."""
    samples: List[float] = []
    top = 0.0
    for path in paths:
        file_samples, file_max = _bigwig_peak_samples(Path(path))
        samples.extend(file_samples)
        top = max(top, file_max)
    return {
        "thresholds": _bigwig_zone_edges(samples),
        "quantiles": list(_BIGWIG_ZONE_QUANTILES),
        "max": top,
        "samples": len(samples),
        "files": len(paths),
    }


class BigWigZoneScaleRequest(BaseModel):
    paths: List[str]


@router.get("/api/browse/bigwig/zone_scale")
async def browse_bigwig_zone_scale(path: str):
    return await run_in_threadpool(lambda: _bigwig_zone_scale_for([path]))


@router.post("/api/browse/bigwig/zone_scale")
async def browse_bigwig_zone_scale_shared(payload: BigWigZoneScaleRequest):
    """Zone edges shared by several files: their peaks pooled, so tracks compare directly."""
    paths = [str(p).strip() for p in (payload.paths or []) if str(p or "").strip()]
    if not paths:
        raise HTTPException(status_code=400, detail="paths must not be empty")
    return await run_in_threadpool(lambda: _bigwig_zone_scale_for(paths))


@router.get("/api/browse/bigwig")
async def browse_bigwig(
    genome: str = "reference",
    path: str = "",
    chrom: str = "",
    start: int = 0,
    end: int = 0,
    bins: int = 600
):
    """Fetch binned signal values for a BigWig file over a genomic range."""
    if not path:
        raise HTTPException(status_code=400, detail="path parameter is required.")
    if not chrom:
        raise HTTPException(status_code=400, detail="chrom parameter is required.")
    if end <= start:
        raise HTTPException(status_code=400, detail="end must be greater than start.")

    # Ensure selected genome is valid/configured (same guardrails as other browse APIs).
    await run_in_threadpool(genome_context._get_browse_db, genome)

    bw_path = Path(path).expanduser()
    if not bw_path.exists() or not bw_path.is_file():
        raise HTTPException(status_code=404, detail=f"BigWig file not found: {bw_path}")

    bins = max(20, min(4000, int(bins)))
    requested_chrom_len: Optional[int] = None
    try:
        fasta = genome_context._get_browse_fasta(genome)
        requested_chrom_len = int(fasta.get_reference_length(chrom))
    except Exception:
        requested_chrom_len = None

    def _query():
        if pyBigWig is None:
            raise HTTPException(
                status_code=503,
                detail="BigWig support is unavailable. Install pyBigWig in the backend environment."
            )

        try:
            bw = pyBigWig.open(str(bw_path))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to open BigWig: {e}")

        if bw is None:
            raise HTTPException(status_code=400, detail="Failed to open BigWig file.")

        try:
            chrom_sizes = bw.chroms() or {}
            resolved_chrom = genome_context._resolve_bigwig_chrom_name(chrom, chrom_sizes, requested_chrom_len=requested_chrom_len)

            if not resolved_chrom:
                return {
                    "path": str(bw_path),
                    "chrom": chrom,
                    "resolved_chrom": None,
                    "start": start,
                    "end": end,
                    "bins": [None] * bins,
                    "has_data": False,
                    "detail": "Chromosome not present in BigWig file.",
                    "min": None,
                    "max": None,
                }

            chrom_len = int(chrom_sizes.get(resolved_chrom, 0))
            q_start = max(0, int(start))
            q_end = min(int(end), chrom_len)
            if q_end <= q_start:
                return {
                    "path": str(bw_path),
                    "chrom": chrom,
                    "resolved_chrom": resolved_chrom,
                    "start": q_start,
                    "end": q_end,
                    "bins": [None] * bins,
                    "has_data": False,
                    "detail": "Requested region is outside the chromosome bounds in BigWig.",
                    "min": None,
                    "max": None,
                }

            values = _bigwig_binned_means(bw, resolved_chrom, int(start), int(end), bins, chrom_len)

            observed = [v for v in values if v is not None]
            has_data = len(observed) > 0

            # The requested range, not the clipped one: every bin is (end - start) / bins
            # wide, and the browser places bin i at start + i * that width.
            return {
                "path": str(bw_path),
                "chrom": chrom,
                "resolved_chrom": resolved_chrom,
                "start": int(start),
                "end": int(end),
                "bins": values,
                "has_data": has_data,
                "detail": "" if has_data else "No data in this region.",
                "min": min(observed) if observed else None,
                "max": max(observed) if observed else None,
            }
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_query)


# ── BigWig batch / overview endpoint ─────────────────────────────────────────

class BigWigBatchTile(BaseModel):
    start: int
    end: int
    bins: int


class BigWigBatchRequest(BaseModel):
    path: str
    chrom: str
    genome: str = "reference"
    tiles: List[BigWigBatchTile]


@router.post("/api/browse/bigwig_batch")
async def browse_bigwig_batch(payload: BigWigBatchRequest):
    """
    Fetch multiple BigWig tiles in one request to reduce HTTP round-trips.
    Returns a list of tile results in the same order as requested.
    """
    if pyBigWig is None:
        raise HTTPException(status_code=503, detail="BigWig support is unavailable. Install pyBigWig.")

    path = str(payload.path or "").strip()
    chrom = str(payload.chrom or "").strip()
    genome = str(payload.genome or "reference").strip() or "reference"
    if not path:
        raise HTTPException(status_code=400, detail="path is required.")
    if not chrom:
        raise HTTPException(status_code=400, detail="chrom is required.")

    await run_in_threadpool(genome_context._get_browse_db, genome)
    p = Path(path).expanduser()
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"BigWig not found: {p}")

    requested_chrom_len: Optional[int] = None
    try:
        fasta = genome_context._get_browse_fasta(genome)
        requested_chrom_len = int(fasta.get_reference_length(chrom))
    except Exception:
        requested_chrom_len = None

    def _run():
        try:
            bw = pyBigWig.open(str(p))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to open BigWig: {e}")
        if bw is None:
            raise HTTPException(status_code=400, detail="Failed to open BigWig file.")

        try:
            chrom_sizes = bw.chroms() or {}
            resolved_chrom = genome_context._resolve_bigwig_chrom_name(
                chrom,
                chrom_sizes,
                requested_chrom_len=requested_chrom_len,
            )
            results = []
            for tile in payload.tiles:
                tile_bins = max(20, min(4000, int(tile.bins)))
                if resolved_chrom is None:
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": False,
                        "bins": [None] * tile_bins,
                        "min": None,
                        "max": None,
                    })
                    continue
                chrom_len = int(chrom_sizes.get(resolved_chrom, 0))
                s = max(0, int(tile.start))
                e = min(chrom_len, int(tile.end)) if chrom_len > 0 else int(tile.end)
                if e <= s or int(tile.end) <= int(tile.start):
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": False,
                        "bins": [None] * tile_bins,
                        "min": None,
                        "max": None,
                    })
                    continue
                try:
                    bins = _bigwig_binned_means(
                        bw, resolved_chrom, int(tile.start), int(tile.end), tile_bins, chrom_len,
                    )
                    valid = [value for value in bins if value is not None]
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": bool(valid),
                        "bins": bins,
                        "min": min(valid) if valid else None,
                        "max": max(valid) if valid else None,
                    })
                except Exception as e2:
                    results.append({
                        "start": tile.start,
                        "end": tile.end,
                        "has_data": False,
                        "bins": [],
                        "error": str(e2),
                    })
            return {
                "path": str(p),
                "chrom": chrom,
                "resolved_chrom": resolved_chrom,
                "tiles": results,
            }
        finally:
            try:
                bw.close()
            except Exception:
                pass

    return await run_in_threadpool(_run)
