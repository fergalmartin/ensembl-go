"""Random access to plain BED and GFF/GTF files, shaped like a pyBigWig BigBed handle.

A plain BED file has no index, so the browser used to scan the whole file on every
request — once per pan step, per track. Here a file is read once into per-chromosome
arrays sorted by start, and then answers range queries by binary search until the file
changes on disk. A bgzipped file with a tabix index is queried through the index instead,
so a very large annotation is never pulled into memory.

GFF3 and GTF files are read the same way, as generic intervals: one feature per line,
with no gene models assembled from them (the custom-genome annotation import does that).
Each line becomes a BED-shaped row — 0-based start, a name taken from the usual
attributes, the file's own colour where it gives one — and its type, source and
attributes ride along as named extra fields.

Both sources expose the three calls the BigBed tile endpoints make — ``chroms()``,
``entries(chrom, start, end)`` and ``SQL()`` — with ``entries`` returning the same
``(start, end, rest)`` rows pyBigWig does, ``rest`` being the tab-joined columns after
the first three. That lets plain BED share the BigBed tiling, parsing and summarising
unchanged.
"""

from __future__ import annotations

import bisect
import gzip
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import unquote

_SKIP_PREFIXES = ("#", "track", "browser")
_GFF_SUFFIXES = (".gff", ".gff3", ".gtf", ".gff.gz", ".gff3.gz", ".gtf.gz")

ParsedLine = Optional[Tuple[str, int, int, str]]


def is_plain_bed_path(path: Path) -> bool:
    lower = str(path.name or "").strip().lower()
    return lower.endswith(".bed") or lower.endswith(".bed.gz")


def is_gff_path(path: Path) -> bool:
    lower = str(path.name or "").strip().lower()
    return lower.endswith(_GFF_SUFFIXES)


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


# The columns a GFF row is given after chrom/start/end, as autoSql, so the BigBed row
# parser picks out name/score/strand/itemRgb by name and reports the rest as named extras.
GFF_AUTOSQL = b"""table gffFeature
"A GFF3/GTF line read as a generic interval"
(
  string chrom;       "Sequence name"
  uint chromStart;    "Start, 0-based"
  uint chromEnd;      "End, exclusive"
  string name;        "ID, Name or gene name"
  string score;       "Score"
  char[1] strand;     "Strand"
  string itemRgb;     "Colour from the color attribute"
  string Type;        "Feature type (column 3)"
  string Source;      "Source (column 2)"
  string Phase;       "Phase (column 8)"
  string Attributes;  "Attributes (column 9)"
)
"""

_GTF_ATTR_RE = re.compile(r'\s*([^\s;]+)\s+(?:"([^"]*)"|([^;]*))\s*;?')
_NAME_KEYS = ("Name", "gene_name", "ID", "transcript_name", "transcript_id", "gene_id", "Alias")
_COLOUR_KEYS = ("color", "colour", "Color", "Colour")
_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6})$")
_RGB_RE = re.compile(r"^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$")


def _gff_attributes(text: str) -> Dict[str, str]:
    """GFF3 ``key=value;`` or GTF ``key "value";`` — whichever the line uses."""
    out: Dict[str, str] = {}
    if not text or text == ".":
        return out
    if "=" in text.split(";", 1)[0]:
        for part in text.split(";"):
            key, sep, value = part.partition("=")
            key = key.strip()
            if sep and key and key not in out:
                out[key] = unquote(value.strip())
        return out
    for match in _GTF_ATTR_RE.finditer(text):
        key = match.group(1)
        value = match.group(2) if match.group(2) is not None else (match.group(3) or "").strip()
        if key and key not in out:
            out[key] = value
    return out


def _item_rgb(value: str) -> str:
    """A colour attribute as the ``r,g,b`` itemRgb the renderer reads, or ''."""
    token = str(value or "").strip()
    hex_match = _HEX_RE.match(token)
    if hex_match:
        h = hex_match.group(1)
        return f"{int(h[0:2], 16)},{int(h[2:4], 16)},{int(h[4:6], 16)}"
    rgb_match = _RGB_RE.match(token)
    if rgb_match and all(int(v) <= 255 for v in rgb_match.groups()):
        return ",".join(rgb_match.groups())
    return ""


def _split_gff_line(line: str) -> ParsedLine:
    line = line.rstrip("\r\n")
    if not line or line.startswith("#"):
        return None
    cols = line.split("\t")
    if len(cols) < 8:
        return None
    try:
        first = int(cols[3])
        last = int(cols[4])
    except ValueError:
        return None
    # Ordered before converting: GFF is 1-based and inclusive, BED rows 0-based, half-open.
    start = min(first, last) - 1
    end = max(first, last)
    attrs_text = cols[8] if len(cols) > 8 else ""
    attrs = _gff_attributes(attrs_text)
    feature_type = cols[2]
    name = next((attrs[k] for k in _NAME_KEYS if attrs.get(k)), "") or feature_type
    colour = next((_item_rgb(attrs[k]) for k in _COLOUR_KEYS if attrs.get(k)), "")
    score = cols[5] if cols[5] not in (".", "") else ""
    strand = cols[6] if cols[6] in ("+", "-") else "."
    phase = cols[7] if cols[7] not in (".", "") else ""
    rest = "\t".join((
        name.replace("\t", " "),
        score,
        strand,
        colour,
        feature_type,
        cols[1] if cols[1] != "." else "",
        phase,
        attrs_text.replace("\t", " ") if attrs_text != "." else "",
    ))
    return cols[0], start, end, rest


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
    """A whole BED or GFF file held as sorted arrays per chromosome."""

    def __init__(self, path: Path, parse_line: Callable[[str], ParsedLine] = None, sql: Optional[bytes] = None):
        if parse_line is None:
            parse_line, sql = _parser_for(path)
        self._sql = sql
        opener = gzip.open if str(path).lower().endswith(".gz") else open
        by_chrom: Dict[str, List[Tuple[int, int, str]]] = {}
        with opener(str(path), "rt", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                # A GFF3 file may end with its sequences; nothing after this is a feature.
                if line.startswith("##FASTA"):
                    break
                parsed = parse_line(line)
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
        return self._sql

    def close(self) -> None:
        return None


class TabixBedSource:
    """A bgzipped, tabix-indexed BED or GFF file, queried through its index."""

    def __init__(self, path: Path, parse_line: Callable[[str], ParsedLine] = None, sql: Optional[bytes] = None):
        import pysam  # imported lazily: only needed for indexed files

        self._tbx = pysam.TabixFile(str(path))
        if parse_line is None:
            parse_line, sql = _parser_for(path)
        self._parse_line = parse_line
        self._sql = sql

    def chroms(self) -> Dict[str, int]:
        return {chrom: 0 for chrom in (self._tbx.contigs or [])}

    def entries(self, chrom: str, start: int, end: int) -> List[Tuple[int, int, str]]:
        if end <= start or chrom not in set(self._tbx.contigs or []):
            return []
        out: List[Tuple[int, int, str]] = []
        for line in self._tbx.fetch(chrom, max(0, int(start)), int(end)):
            parsed = self._parse_line(line)
            if parsed is None:
                continue
            _, f_start, f_end, rest = parsed
            if f_end > start and f_start < end:
                out.append((f_start, f_end, rest))
        return out

    def SQL(self):  # noqa: N802 - mirrors pyBigWig
        return self._sql

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
        return self._inner.SQL()

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


def _parser_for(path: Path) -> Tuple[Callable[[str], ParsedLine], Optional[bytes]]:
    if is_gff_path(path):
        return _split_gff_line, GFF_AUTOSQL
    return _split_bed_line, None


def get_plain_bed_index(path: Path) -> PlainBedIndex:
    """The cached index for a BED or GFF file, rebuilt when the file changes."""
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
        parse_line, sql = _parser_for(path)
        index = PlainBedIndex(path, parse_line=parse_line, sql=sql)
        with _INDEX_CACHE_LOCK:
            _INDEX_CACHE[key] = (sig, index)
            _INDEX_CACHE.move_to_end(key)
            while len(_INDEX_CACHE) > _INDEX_CACHE_MAX:
                _INDEX_CACHE.popitem(last=False)
        return index


def open_plain_bed(path: Path):
    """A BigBed-shaped handle on a plain BED or GFF file; the caller closes it."""
    if str(path).lower().endswith(".gz") and _has_tabix_index(path):
        parse_line, sql = _parser_for(path)
        return TabixBedSource(path, parse_line=parse_line, sql=sql)
    return _NonClosing(get_plain_bed_index(path))
