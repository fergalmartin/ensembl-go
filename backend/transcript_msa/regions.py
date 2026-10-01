"""What goes into an alignment for one transcript: its region, as ordered genomic segments.

Two modes:

``exons`` (the default)
    The exons, ``intron_edge`` bases at each end of every intron, and ``flank_5`` /
    ``flank_3`` bases beyond the transcript. The middle of each longer intron is cut out,
    so MAFFT sees the exons with their splice sites and little else.
``genomic``
    One window: the transcript with its flanks, introns and all.

A region's segments run 5'->3' along the transcript (a minus-strand transcript's segments
are in descending genomic order and its sequence is reverse-complemented), each with its
``offset`` in the concatenated sequence. ``cuts`` say where intron sequence was left out.
Everything here is plain data, so a region can be stored with the alignment it built.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

MODES = ('exons', 'genomic')
DEFAULT_MODE = 'exons'
DEFAULT_FLANK = 100
DEFAULT_INTRON_EDGE = 10

_COMPLEMENT = str.maketrans('ACGTUNacgtunRYKMSWBDHVrykmswbdhv', 'TGCAANtgcaanYRMKSWVHDByrmkswvhdb')


def reverse_complement(seq: str) -> str:
    return seq.translate(_COMPLEMENT)[::-1]


# ── transcripts ──

def _interval(item: Any) -> Optional[Tuple[int, int]]:
    if isinstance(item, dict):
        start, end = item.get('start'), item.get('end')
    elif isinstance(item, (list, tuple)) and len(item) >= 2:
        # (start, end[, phase]) or (kind, start, end)
        start, end = (item[1], item[2]) if isinstance(item[0], str) and len(item) >= 3 else (item[0], item[1])
    else:
        start, end = getattr(item, 'start', None), getattr(item, 'end', None)
    try:
        start, end = int(start), int(end)
    except (TypeError, ValueError):
        return None
    return (start, end) if start <= end else (end, start)


def _get(obj: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        value = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
        if value is not None:
            return value
    return default


def _merge(intervals: Iterable[Tuple[int, int]]) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    for start, end in sorted(intervals):
        if out and start <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out


def normalise_transcript(tx: Any) -> Dict[str, Any]:
    """A transcript as plain data: ``{id, chrom, strand, start, end, exons, cds, utrs}``.

    Takes the app's ``SimpleTranscript`` (or its ``asdict``) as well as this form. Exons
    are merged where they touch or overlap; UTRs are ``(kind, start, end)`` with kind
    ``utr5`` / ``utr3``.
    """
    if isinstance(tx, dict) and tx.get('_normalised'):
        return tx
    strand = '-' if str(_get(tx, 'strand', default='+')) == '-' else '+'
    exons = _merge(i for i in (_interval(e) for e in _get(tx, 'exons', default=[]) or []) if i)
    cds = sorted(i for i in (_interval(c) for c in _get(tx, 'cds', 'cds_list', default=[]) or []) if i)
    utrs = []
    for utr in _get(tx, 'utrs', default=[]) or []:
        span = _interval(utr)
        if not span:
            continue
        kind = _get(utr, 'kind', 'feature_type', 'type', default='') if not isinstance(utr, (list, tuple)) else utr[0]
        kind = str(kind or '').lower()
        kind = 'utr5' if kind in ('utr5', 'five_prime_utr', '5utr') or kind.startswith('five') else 'utr3'
        utrs.append((kind, span[0], span[1]))
    start = int(_get(tx, 'start', default=exons[0][0] if exons else 0) or 0)
    end = int(_get(tx, 'end', default=exons[-1][1] if exons else 0) or 0)
    if not exons and start and end:
        exons = [(min(start, end), max(start, end))]
    return {
        '_normalised': True,
        'id': str(_get(tx, 'id', 'feature_id', default='') or ''),
        'gene_id': str(_get(tx, 'gene_id', 'parent_gene_id', default='') or ''),
        'chrom': str(_get(tx, 'chrom', 'seq_region', default='') or ''),
        'strand': strand,
        'start': min(start, end) if start and end else (exons[0][0] if exons else 0),
        'end': max(start, end) if start and end else (exons[-1][1] if exons else 0),
        'exons': exons,
        'cds': cds,
        'utrs': sorted(utrs, key=lambda u: (u[1], u[2])),
        'biotype': str(_get(tx, 'biotype', default='') or ''),
    }


def structure_hash(tx: Any) -> str:
    """A fingerprint of a transcript's model: a changed annotation never reuses an alignment."""
    t = normalise_transcript(tx)
    blob = json.dumps([t['chrom'], t['strand'], t['exons'], t['cds'], t['utrs']], separators=(',', ':'))
    return hashlib.sha256(blob.encode('utf-8')).hexdigest()[:16]


# ── regions ──

def _finish(meta: Dict[str, Any], ascending: List[Tuple[int, int, str]]) -> Dict[str, Any]:
    """Orient segments 5'->3', give each its offset, and find the cuts between them."""
    minus = meta['strand'] == '-'
    ordered = list(reversed(ascending)) if minus else list(ascending)
    segments: List[Dict[str, Any]] = []
    cuts: List[Dict[str, Any]] = []
    offset = 0
    for start, end, kind in ordered:
        if end < start:
            continue
        if segments:
            prev = segments[-1]
            gap = (prev['start'] - end - 1) if minus else (start - prev['end'] - 1)
            if gap > 0:
                lo, hi = (end + 1, prev['start'] - 1) if minus else (prev['end'] + 1, start - 1)
                cuts.append({'at': offset, 'start': lo, 'end': hi, 'removed': hi - lo + 1})
        length = end - start + 1
        segments.append({'start': start, 'end': end, 'kind': kind, 'offset': offset, 'length': length})
        offset += length
    return {**meta, 'segments': segments, 'cuts': cuts, 'length': offset}


def plan_region(tx: Any, mode: str = DEFAULT_MODE, flank_5: int = DEFAULT_FLANK, flank_3: int = DEFAULT_FLANK,
                intron_edge: int = DEFAULT_INTRON_EDGE, bounds: Optional[Tuple[int, int]] = None) -> Dict[str, Any]:
    """The region to align for a transcript, before any sequence is fetched.

    ``bounds`` (genomic mode only) widens the window from the transcript to a span such as
    its gene's, as the MSA view's "use gene boundaries" does: the same genes aligned by
    either view then read the same sequence, and each can reuse the other's alignment.
    """
    t = normalise_transcript(tx)
    mode = mode if mode in MODES else DEFAULT_MODE
    flank_5, flank_3, edge = max(0, int(flank_5 or 0)), max(0, int(flank_3 or 0)), max(0, int(intron_edge or 0))
    minus = t['strand'] == '-'
    exons = t['exons']
    left, right = exons[0][0], exons[-1][1]
    flank_left, flank_right = (flank_3, flank_5) if minus else (flank_5, flank_3)
    meta = {'transcript_id': t['id'], 'chrom': t['chrom'], 'strand': t['strand'], 'mode': mode,
            'flank_5': flank_5, 'flank_3': flank_3, 'intron_edge': edge if mode == 'exons' else 0}
    if mode == 'genomic':
        if bounds and bounds[0] and bounds[1]:
            left, right = min(bounds), max(bounds)
        return _finish(meta, [(max(1, left - flank_left), right + flank_right, 'genomic')])
    ascending: List[Tuple[int, int, str]] = []
    if flank_left and left > 1:
        ascending.append((max(1, left - flank_left), left - 1, 'flank3' if minus else 'flank5'))
    for i, (start, end) in enumerate(exons):
        ascending.append((start, end, 'exon'))
        if i + 1 == len(exons):
            break
        a, b = end + 1, exons[i + 1][0] - 1
        if b - a + 1 <= 2 * edge:
            ascending.append((a, b, 'intron'))
        elif edge:
            ascending.append((a, a + edge - 1, 'intron_edge'))
            ascending.append((b - edge + 1, b, 'intron_edge'))
    if flank_right:
        ascending.append((right + 1, right + flank_right, 'flank5' if minus else 'flank3'))
    return _finish(meta, ascending)


def window_region(tx: Any, start: int, end: int, flank_5: int, flank_3: int) -> Dict[str, Any]:
    """A genomic-mode region for a window already chosen (the MSA view picks its own)."""
    t = normalise_transcript(tx)
    meta = {'transcript_id': t['id'], 'chrom': t['chrom'], 'strand': t['strand'], 'mode': 'genomic',
            'flank_5': max(0, int(flank_5 or 0)), 'flank_3': max(0, int(flank_3 or 0)), 'intron_edge': 0}
    return _finish(meta, [(min(start, end), max(start, end), 'genomic')])


def params_of(region: Dict[str, Any]) -> Dict[str, Any]:
    return {'mode': region['mode'], 'flank_5': region['flank_5'], 'flank_3': region['flank_3'],
            'intron_edge': region['intron_edge']}


def fetch_sequence(region: Dict[str, Any],
                   fetch: Callable[[str, int, int], Tuple[str, int, int]]) -> Tuple[Dict[str, Any], str]:
    """The region's sequence, 5'->3', and the region as actually fetched.

    ``fetch(chrom, start, end)`` returns ``(forward-strand sequence, start, end)`` for
    what it could read: a flank running off a contig's end comes back shorter, and the
    region's segments are clipped to match. Touching segments are fetched together.
    """
    ascending = sorted(((s['start'], s['end'], s['kind']) for s in region['segments']), key=lambda s: s[0])
    blocks: List[List[Tuple[int, int, str]]] = []
    for seg in ascending:
        if blocks and seg[0] == blocks[-1][-1][1] + 1:
            blocks[-1].append(seg)
        else:
            blocks.append([seg])
    clipped: List[Tuple[int, int, str]] = []
    pieces: List[Tuple[int, int, str]] = []  # (start, end, sequence) for each clipped segment
    for block in blocks:
        seq, got_start, got_end = fetch(region['chrom'], block[0][0], block[-1][1])
        seq = str(seq or '').upper()
        if not seq:
            continue
        got_end = got_start + len(seq) - 1
        for start, end, kind in block:
            lo, hi = max(start, got_start), min(end, got_end)
            if lo > hi:
                continue
            clipped.append((lo, hi, kind))
            pieces.append((lo, hi, seq[lo - got_start:hi - got_start + 1]))
    meta = {k: v for k, v in region.items() if k not in ('segments', 'cuts', 'length')}
    fetched = _finish(meta, clipped)
    ordered = [p[2] for p in sorted(pieces, key=lambda p: p[0], reverse=region['strand'] == '-')]
    sequence = ''.join(reverse_complement(p) for p in ordered) if region['strand'] == '-' else ''.join(ordered)
    return fetched, sequence


# ── coordinates ──

def _segment_at(region: Dict[str, Any], index: int) -> Optional[Dict[str, Any]]:
    segments = region['segments']
    lo, hi = 0, len(segments) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        seg = segments[mid]
        if index < seg['offset']:
            hi = mid - 1
        elif index >= seg['offset'] + seg['length']:
            lo = mid + 1
        else:
            return seg
    return None


def ungapped_to_genomic(region: Dict[str, Any], index: int) -> Optional[int]:
    """The genomic position of the region sequence's ``index``-th base (0-based)."""
    seg = _segment_at(region, index)
    if seg is None:
        return None
    step = index - seg['offset']
    return seg['end'] - step if region['strand'] == '-' else seg['start'] + step


def genomic_to_ungapped(region: Dict[str, Any], position: int) -> Optional[int]:
    """Where a genomic position is in the region's sequence, or None if it was left out."""
    for seg in region['segments']:
        if seg['start'] <= position <= seg['end']:
            step = seg['end'] - position if region['strand'] == '-' else position - seg['start']
            return seg['offset'] + step
    return None


def genomic_range_to_ungapped(region: Dict[str, Any], start: int, end: int) -> List[Tuple[int, int]]:
    """A genomic interval in sequence indexes: one ``(first, last)`` per unbroken run.

    Runs that meet across a cut (the two edges of a trimmed intron) join into one.
    """
    lo_g, hi_g = min(start, end), max(start, end)
    spans: List[Tuple[int, int]] = []
    minus = region['strand'] == '-'
    for seg in region['segments']:
        lo, hi = max(seg['start'], lo_g), min(seg['end'], hi_g)
        if lo > hi:
            continue
        if minus:
            spans.append((seg['offset'] + seg['end'] - hi, seg['offset'] + seg['end'] - lo))
        else:
            spans.append((seg['offset'] + lo - seg['start'], seg['offset'] + hi - seg['start']))
    spans.sort()
    out: List[Tuple[int, int]] = []
    for a, b in spans:
        if out and a <= out[-1][1] + 1:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def region_bp(regions: Sequence[Dict[str, Any]]) -> int:
    return sum(int(r.get('length') or 0) for r in regions)
