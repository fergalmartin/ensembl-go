"""Random access to plain BED files, shaped like a pyBigWig BigBed handle.

A plain BED file has no index, so the browser used to scan the whole file on every
request — once per pan step, per track. Here a file is read once into per-chromosome
arrays sorted by start, and then answers range queries by binary search until the file
changes on disk. A bgzipped file with a tabix index is queried through the index instead,
so a very large annotation is never pulled into memory.

Both sources expose the three calls the BigBed tile endpoints make — ``chroms()``,
``entries(chrom, start, end)`` and ``SQL()`` — with ``entries`` returning the same
``(start, end, rest)`` rows pyBigWig does, ``rest`` being the tab-joined columns after
the first three. That lets plain BED share the BigBed tiling, parsing and summarising
unchanged.
"""

from __future__ import annotations

import bisect
import gzip
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_SKIP_PREFIXES = ("#", "track", "browser")


def is_plain_bed_path(path: Path) -> bool:
    lower = str(path.name or "").strip().lower()
    return lower.endswith(".bed") or lower.endswith(".bed.gz")


def _split_bed_line(line: str) -> Optional[Tuple[str, int, int, str]]:
    line = line.rstrip("\r\n")
    if not line or line.startswith(_SKIP_PREFIXES):
        return None
    cols = line.split("\t")
    if len(cols) < 3:
        # Some tools write space-separated BED; accept it rather than show nothing.
        cols = line.split()
        if len(cols) < 3:
            return None
    try:
        start = int(cols[1])
        end = int(cols[2])
    except ValueError:
        return None
    if end < start:
        start, end = end, start
    return cols[0], start, end, "\t".join(cols[3:])


class _ChromArrays:
    __slots__ = ("starts", "ends", "rests", "max_end_prefix", "max_end")

    def __init__(self, rows: List[Tuple[int, int, str]]):
        rows.sort(key=lambda r: (r[0], r[1]))
        self.starts = [r[0] for r in rows]
        self.ends = [r[1] for r in rows]
        self.rests = [r[2] for r in rows]
        # Running maximum of ends. It never decreases, so the first row that can reach
        # past a query start is found by bisecting it — exact, however long the longest
        # feature is.
        prefix: List[int] = []
        running = 0
        for end in self.ends:
            if end > running:
                running = end
            prefix.append(running)
        self.max_end_prefix = prefix
        self.max_end = running

    def entries(self, start: int, end: int) -> List[Tuple[int, int, str]]:
        lo = bisect.bisect_right(self.max_end_prefix, start)
        hi = bisect.bisect_left(self.starts, end)
        out: List[Tuple[int, int, str]] = []
        starts, ends, rests = self.starts, self.ends, self.rests
        for i in range(lo, hi):
            if ends[i] > start:
                out.append((starts[i], ends[i], rests[i]))
        return out


class PlainBedIndex:
    """A whole BED file held as sorted arrays per chromosome."""

    def __init__(self, path: Path):
        opener = gzip.open if str(path).lower().endswith(".gz") else open
        by_chrom: Dict[str, List[Tuple[int, int, str]]] = {}
        with opener(str(path), "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                parsed = _split_bed_line(line)
                if parsed is None:
                    continue
                chrom, start, end, rest = parsed
                bucket = by_chrom.get(chrom)
                if bucket is None:
                    bucket = by_chrom[chrom] = []
                bucket.append((start, end, rest))
        self._chroms = {chrom: _ChromArrays(rows) for chrom, rows in by_chrom.items()}
        self.feature_count = sum(len(rows.starts) for rows in self._chroms.values())

    def chroms(self) -> Dict[str, int]:
        # BED carries no chromosome lengths. Zero tells the tile endpoints not to clip
        # tiles to a length that would only be the last feature's end.
        return {chrom: 0 for chrom in self._chroms}

    def entries(self, chrom: str, start: int, end: int) -> List[Tuple[int, int, str]]:
        arrays = self._chroms.get(chrom)
        if arrays is None or end <= start:
            return []
        return arrays.entries(int(start), int(end))

    def SQL(self):  # noqa: N802 - mirrors pyBigWig
        return None

    def close(self) -> None:
        return None


class TabixBedSource:
    """A bgzipped, tabix-indexed BED file, queried through its index."""

    def __init__(self, path: Path):
        import pysam  # imported lazily: only needed for indexed BED

        self._tbx = pysam.TabixFile(str(path))

    def chroms(self) -> Dict[str, int]:
        return {chrom: 0 for chrom in (self._tbx.contigs or [])}

    def entries(self, chrom: str, start: int, end: int) -> List[Tuple[int, int, str]]:
        if end <= start or chrom not in set(self._tbx.contigs or []):
            return []
        out: List[Tuple[int, int, str]] = []
        for line in self._tbx.fetch(chrom, max(0, int(start)), int(end)):
            parsed = _split_bed_line(line)
            if parsed is None:
                continue
            _, f_start, f_end, rest = parsed
            if f_end > start and f_start < end:
                out.append((f_start, f_end, rest))
        return out

    def SQL(self):  # noqa: N802 - mirrors pyBigWig
        return None

    def close(self) -> None:
        try:
            self._tbx.close()
        except Exception:
            pass


class _NonClosing:
    """Shares a cached index with a caller that will close what it was given."""

    def __init__(self, inner: PlainBedIndex):
        self._inner = inner

    def chroms(self):
        return self._inner.chroms()

    def entries(self, chrom, start, end):
        return self._inner.entries(chrom, start, end)

    def SQL(self):  # noqa: N802 - mirrors pyBigWig
        return None

    def close(self) -> None:
        return None


_INDEX_CACHE: "OrderedDict[str, Tuple[Tuple[int, int], PlainBedIndex]]" = OrderedDict()
_INDEX_CACHE_LOCK = threading.Lock()
_INDEX_BUILD_LOCKS: Dict[str, threading.Lock] = {}
_INDEX_CACHE_MAX = 12


def _signature(path: Path) -> Tuple[int, int]:
    st = path.stat()
    return int(st.st_mtime_ns), int(st.st_size)


def _has_tabix_index(path: Path) -> bool:
    return Path(str(path) + ".tbi").exists() or Path(str(path) + ".csi").exists()


def get_plain_bed_index(path: Path) -> PlainBedIndex:
    """The cached index for ``path``, rebuilt when the file changes."""
    key = str(path.resolve())
    sig = _signature(path)
    with _INDEX_CACHE_LOCK:
        cached = _INDEX_CACHE.get(key)
        if cached and cached[0] == sig:
            _INDEX_CACHE.move_to_end(key)
            return cached[1]
        build_lock = _INDEX_BUILD_LOCKS.setdefault(key, threading.Lock())
    # One build per file: the browser asks for several tiles of every track at once,
    # and each would otherwise parse the same file in parallel.
    with build_lock:
        with _INDEX_CACHE_LOCK:
            cached = _INDEX_CACHE.get(key)
            if cached and cached[0] == sig:
                return cached[1]
        index = PlainBedIndex(path)
        with _INDEX_CACHE_LOCK:
            _INDEX_CACHE[key] = (sig, index)
            _INDEX_CACHE.move_to_end(key)
            while len(_INDEX_CACHE) > _INDEX_CACHE_MAX:
                _INDEX_CACHE.popitem(last=False)
        return index


def open_plain_bed(path: Path):
    """A BigBed-shaped handle on a plain BED file; the caller closes it."""
    if str(path).lower().endswith(".gz") and _has_tabix_index(path):
        return TabixBedSource(path)
    return _NonClosing(get_plain_bed_index(path))
