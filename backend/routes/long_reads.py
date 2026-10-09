"""Long-read BAM tracks: coverage bins at overview zoom and collapsed read rows when
zoomed in, served by /api/browse/long_reads.
"""

from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.concurrency import run_in_threadpool

router = APIRouter()


# ── Long Reads / minimap2 BAM endpoint ───────────────────────────────────────

def _get_bam_coverage_bins(bam_path: str, chrom: str, start: int, end: int, bins: int) -> List[float]:
    """Compute per-bin average coverage from a BAM pileup (requires pysam)."""
    try:
        import pysam  # type: ignore
    except ImportError:
        return []
    span = max(1, end - start)
    counts = [0.0] * bins
    try:
        bam = pysam.AlignmentFile(bam_path, "rb")
        for pileup_col in bam.pileup(chrom, max(0, start - 1), end, min_base_quality=0):
            pos = pileup_col.reference_pos  # 0-based
            if pos < start or pos >= end:
                continue
            idx = int((pos - start) / span * bins)
            idx = max(0, min(bins - 1, idx))
            counts[idx] += pileup_col.nsegments
        bam.close()
    except Exception:
        pass
    return counts


def _collapse_long_reads(reads: List[Dict]) -> List[Dict]:
    """
    Collapse minimap2 long reads by splice pattern (exon blocks).
    Reads with identical block structures are merged into a 'transcript model'
    with a read count. Returns a list of collapsed models sorted by start.
    """
    pattern_map: Dict[str, Dict] = {}
    for read in reads:
        blocks = read.get("blocks", [])
        key = "|".join(f"{b[0]}-{b[1]}" for b in blocks)
        if key not in pattern_map:
            pattern_map[key] = {
                "start": read["start"],
                "end": read["end"],
                "strand": read.get("strand", "."),
                "blocks": blocks,
                "count": 0,
                "name": read.get("name", ""),
            }
        pattern_map[key]["count"] += 1

    collapsed = sorted(pattern_map.values(), key=lambda x: x["start"])
    # Sort by count descending within the same region
    collapsed.sort(key=lambda x: (-x["count"], x["start"]))
    return collapsed


@router.get("/api/browse/long_reads")
async def browse_long_reads(
    path: str,
    chrom: str,
    start: int,
    end: int,
    bins: int = 500,
    level: str = "fine",
    max_reads: int = 2000,
    collapse: bool = True,
):
    """
    Query a minimap2 BAM for long reads overlapping [start, end).
    - For fine levels: returns collapsed read models (grouped by splice pattern)
    - For coarse levels: returns coverage bins
    """
    def _run():
        try:
            import pysam  # type: ignore
        except ImportError:
            raise HTTPException(status_code=503, detail="pysam not installed. Run: pip install pysam")

        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"BAM not found: {path}")

        if level != "fine":
            cov = _get_bam_coverage_bins(str(p), chrom, start, end, bins)
            max_cov = max(cov) if cov else 0
            return {"level": level, "start": start, "end": end, "bins": cov, "max_count": max_cov}

        # Fine level: return individual reads (collapsed)
        reads = []
        try:
            bam = pysam.AlignmentFile(str(p), "rb")
            for aln in bam.fetch(chrom, max(0, start - 1), end):
                if aln.is_unmapped or aln.is_secondary or aln.is_supplementary:
                    continue
                if aln.reference_start is None or aln.reference_end is None:
                    continue
                # Extract aligned blocks (exon-level)
                blocks = aln.get_blocks()  # list of (start, end) 0-based half-open
                strand = "-" if aln.is_reverse else "+"
                reads.append({
                    "name": aln.query_name or "",
                    "start": aln.reference_start,
                    "end": aln.reference_end,
                    "strand": strand,
                    "blocks": [[b[0], b[1]] for b in blocks],
                    "mapq": aln.mapping_quality or 0,
                })
                if len(reads) >= max_reads:
                    break
            bam.close()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"BAM query error: {e}")

        if collapse:
            models = _collapse_long_reads(reads)
        else:
            models = reads

        return {
            "level": level,
            "start": start,
            "end": end,
            "reads": models,
            "collapsed": collapse,
            "total_input_reads": len(reads),
        }

    return await run_in_threadpool(_run)
