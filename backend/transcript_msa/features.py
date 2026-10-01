"""A transcript's features in alignment columns, for a region made of segments.

The same features, in the same shape and order, as the MSA view's
``map_features_to_alignment`` (main.py), which it generalises: that one assumes a single
contiguous window, this one follows a region's segments, so a trimmed intron still maps.
``{type, start, end, original_start, original_end}``, start/end being alignment columns
(inclusive) and original_* the feature's genomic span. Features come lowest priority first
(exon/intron, then CDS/UTR, then splice sites and codons), so a painter taking the last
feature covering a column shows the most specific one.

One type is new: ``intron_cut``, where intron sequence was left out of the region. Its
start and end are the columns of the bases either side of the cut, and ``removed_bp`` says
how much is missing. Painters that don't know it skip it.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .regions import genomic_range_to_ungapped, genomic_to_ungapped, normalise_transcript


def residue_columns(aligned: str) -> List[int]:
    """The alignment column of each residue, in order."""
    return [i for i, c in enumerate(aligned) if c != '-']


def map_features(tx: Any, region: Dict[str, Any], aligned: str, sequence: str = '') -> List[Dict[str, Any]]:
    """Map a transcript's features onto an aligned row built from ``region``.

    ``sequence`` is the region's ungapped sequence (5'->3'), used to confirm GT/AG at
    splice sites; without it the aligned row itself is read.
    """
    t = normalise_transcript(tx)
    columns = residue_columns(aligned)
    if len(columns) < region['length']:
        raise ValueError(f"aligned row has {len(columns)} residues, region has {region['length']}")
    raw = (sequence or ''.join(aligned[c] for c in columns)).upper()
    minus = t['strand'] == '-'
    found: List[Dict[str, Any]] = []

    def add(kind: str, start: int, end: int, priority: int) -> None:
        for first, last in genomic_range_to_ungapped(region, start, end):
            found.append({'type': kind, 'start': columns[first], 'end': columns[last],
                          'original_start': start, 'original_end': end, 'priority': priority})

    def site(first_base: int, step: int) -> Optional[str]:
        """Two bases read 5'->3' from ``first_base``, if both are in the region side by side."""
        at = genomic_to_ungapped(region, first_base)
        if at is None or genomic_to_ungapped(region, first_base + step) != at + 1:
            return None
        return raw[at:at + 2]

    exons = t['exons']
    for start, end in exons:
        add('exon', start, end, 3)
    for (_, left_end), (right_start, _) in zip(exons, exons[1:]):
        if right_start - 1 >= left_end + 1:
            add('intron', left_end + 1, right_start - 1, 3)
    for start, end in t['cds']:
        add('cds', start, end, 2)
    for kind, start, end in t['utrs']:
        add(kind, start, end, 2)

    # Splice sites, in transcript order: a donor (GT) after every exon but the last, an
    # acceptor (AG) before every exon but the first.
    step = -1 if minus else 1
    ordered = list(reversed(exons)) if minus else exons
    for i, (start, end) in enumerate(ordered):
        three_prime, five_prime = (start, end) if minus else (end, start)
        if i < len(ordered) - 1:
            first = three_prime + step
            if site(first, step) == 'GT':
                add('donor', min(first, first + step), max(first, first + step), 1)
        if i > 0:
            first = five_prime - 2 * step
            if site(first, step) == 'AG':
                add('acceptor', min(first, first + step), max(first, first + step), 1)

    if t['cds']:
        cds_start, cds_end = t['cds'][0][0], t['cds'][-1][1]
        if minus:
            add('start_codon', cds_end - 2, cds_end, 1)
            add('stop_codon', cds_start, cds_start + 2, 1)
        else:
            add('start_codon', cds_start, cds_start + 2, 1)
            add('stop_codon', cds_end - 2, cds_end, 1)

    found.sort(key=lambda f: -f['priority'])
    out = [{k: v for k, v in f.items() if k != 'priority'} for f in found]
    for cut in region.get('cuts') or []:
        before, after = cut['at'] - 1, cut['at']
        if 0 <= before and after < len(columns):
            out.append({'type': 'intron_cut', 'start': columns[before], 'end': columns[after],
                        'original_start': cut['start'], 'original_end': cut['end'], 'removed_bp': cut['removed']})
    return out
