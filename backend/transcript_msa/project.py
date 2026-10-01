"""An alignment cut down to some of its rows.

Rows are taken as they are; columns that are gaps in every row kept are dropped, and each
row's features follow their columns. This is what lets one alignment of a whole tree serve
any subtree or layer of it, and the MSA view reuse a gene tree's alignment.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

_OCCUPIED = bytes(0 if c == ord('-') else 1 for c in range(256))


def occupied_runs(sequences: Sequence[str], length: int) -> List[Tuple[int, int]]:
    """Half-open ``(start, end)`` runs of columns where at least one sequence has a residue."""
    if not sequences or length <= 0:
        return []
    mask = 0
    for seq in sequences:
        mask |= int.from_bytes(seq.encode('ascii', 'replace').translate(_OCCUPIED).ljust(length, b'\x00'), 'big')
    flags = mask.to_bytes(length, 'big')
    runs: List[Tuple[int, int]] = []
    start: Optional[int] = None
    for i, flag in enumerate(flags):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, length))
    return runs


class ColumnMap:
    """Old column -> new column, for the columns kept as ``runs``."""

    def __init__(self, runs: Sequence[Tuple[int, int]]):
        self.starts = [a for a, _ in runs]
        self.ends = [b for _, b in runs]
        self.before: List[int] = []
        total = 0
        for a, b in runs:
            self.before.append(total)
            total += b - a
        self.length = total

    def first_at_or_after(self, column: int) -> Optional[int]:
        i = bisect_right(self.ends, column)
        if i >= len(self.starts):
            return None
        return self.before[i] + max(0, column - self.starts[i])

    def last_at_or_before(self, column: int) -> Optional[int]:
        i = bisect_right(self.starts, column) - 1
        if i < 0:
            return None
        return self.before[i] + min(column, self.ends[i] - 1) - self.starts[i]


def remap_features(features: Iterable[Dict[str, Any]], columns: ColumnMap) -> List[Dict[str, Any]]:
    out = []
    for f in features:
        start, end = columns.first_at_or_after(int(f['start'])), columns.last_at_or_before(int(f['end']))
        if start is None or end is None or end < start:
            continue
        out.append({**f, 'start': start, 'end': end})
    return out


def consensus(sequences: Sequence[str]) -> str:
    """Each column's commonest residue (ties to the alphabetically first), '-' if none."""
    out = []
    for column in zip(*sequences):
        counts = Counter(c for c in column if c != '-')
        out.append(min(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0] if counts else '-')
    return ''.join(out)


def identity_to(seq: str, reference: str) -> float:
    """Percent of the reference's residue columns where ``seq`` has the same residue."""
    matches = total = 0
    for a, c in zip(seq, reference):
        if c == '-':
            continue
        total += 1
        matches += a == c
    return matches / total * 100.0 if total else 0.0


def summarise(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Consensus and per-row identity/gap fraction for rows with ``aligned`` sequences."""
    seqs = [r['aligned'] for r in rows]
    cons = consensus(seqs) if seqs else ''
    for row in rows:
        row['identity'] = identity_to(row['aligned'], cons)
        row['gap_fraction'] = row['aligned'].count('-') / max(1, len(row['aligned']))
    return {'consensus': cons, 'average_identity': sum(r['identity'] for r in rows) / max(1, len(rows))}


def project(alignment: Dict[str, Any], row_keys: Iterable[str]) -> Dict[str, Any]:
    """``alignment`` with only ``row_keys`` (in that order), its all-gap columns removed.

    Rows carry ``row_key``, ``aligned`` and ``features``; everything else is kept as is.
    Keys it doesn't have are listed in ``missing``.
    """
    by_key = {r['row_key']: r for r in alignment['rows']}
    wanted = list(dict.fromkeys(row_keys))
    chosen = [by_key[k] for k in wanted if k in by_key]
    length = int(alignment.get('alignment_length') or (len(chosen[0]['aligned']) if chosen else 0))
    runs = occupied_runs([r['aligned'] for r in chosen], length)
    whole = runs == [(0, length)]
    columns = ColumnMap(runs)
    rows = []
    for row in chosen:
        aligned = row['aligned'] if whole else ''.join(row['aligned'][a:b] for a, b in runs)
        features = row.get('features') or []
        rows.append({**row, 'aligned': aligned, 'features': list(features) if whole else remap_features(features, columns)})
    stats = summarise(rows)
    return {**{k: v for k, v in alignment.items() if k not in ('rows', 'consensus')},
            'alignment_length': columns.length, 'rows': rows, 'missing': [k for k in wanted if k not in by_key], **stats}
