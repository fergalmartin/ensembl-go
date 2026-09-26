"""Random access to plain BED and GFF/GTF files, shaped like a pyBigWig BigBed handle.

A plain BED file has no index, so the browser used to scan the whole file on every
request — once per pan step, per track. Here a file is read once into per-chromosome
arrays sorted by start, and then answers range queries by binary search until the file
changes on disk. A bgzipped file with a tabix index is queried through the index instead,
so a very large annotation is never pulled into memory.

GFF3 and GTF files are read the same way, as generic intervals: one feature per line.
Or, as gene models: exons, CDS and UTRs gathered under their transcripts into BED12-
shaped rows, so the browser draws transcript structures. That is display only — nothing
here joins the annotation the app uses for genes (the custom-genome import does that).
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


# ── Gene models ───────────────────────────────────────────────────────────────

GENE_MODEL_AUTOSQL = b"""table gffTranscript
"A transcript assembled from GFF3/GTF exon, CDS and UTR lines"
(
  string chrom;        "Sequence name"
  uint chromStart;     "Start, 0-based"
  uint chromEnd;       "End, exclusive"
  string name;         "Transcript or gene name"
  string score;        "Score"
  char[1] strand;      "Strand"
  uint thickStart;     "CDS start"
  uint thickEnd;       "CDS end"
  string itemRgb;      "Colour from the color attribute"
  int blockCount;      "Exon count"
  int[blockCount] blockSizes;  "Exon sizes"
  int[blockCount] chromStarts; "Exon starts, relative to chromStart"
  string Gene;         "Gene name"
  string GeneID;       "Gene ID"
  string Transcript;   "Transcript ID"
  string Biotype;      "Biotype"
  string Type;         "Feature type (column 3)"
  string Source;       "Source (column 2)"
)
"""

# Lines that describe part of a transcript rather than a feature of their own.
_EXON_TYPES = {"exon", "noncoding_exon", "pseudogenic_exon"}
_CDS_TYPES = {"CDS", "cds"}
_UTR_TYPES = {"five_prime_UTR", "three_prime_UTR", "UTR", "5UTR", "3UTR", "utr",
              "five_prime_utr", "three_prime_utr"}
_PART_TYPES = _EXON_TYPES | _CDS_TYPES | _UTR_TYPES | {
    "start_codon", "stop_codon", "stop_codon_redefined_as_selenocysteine", "Selenocysteine", "intron",
}
# Whole-sequence records: drawn, they would be one bar the length of the chromosome.
_SEQUENCE_TYPES = {"region", "chromosome", "scaffold", "contig", "supercontig"}
_PARENT_RE = re.compile(r"(?:^|;)\s*Parent=([^;]*)")
_GTF_TX_RE = re.compile(r'transcript_id\s+"([^"]*)"')


def _strip_prefix(value: str) -> str:
    """Ensembl GFF3 IDs carry a type prefix (``transcript:ENS...``); show the ID alone."""
    head, sep, tail = str(value or "").partition(":")
    return tail if sep and head in ("gene", "transcript", "CDS", "exon") else str(value or "")


def _merge_intervals(intervals: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    for start, end in sorted(intervals):
        if out and start <= out[-1][1]:
            if end > out[-1][1]:
                out[-1] = (out[-1][0], end)
        else:
            out.append((start, end))
    return out


def _clean(value: str) -> str:
    return str(value or "").replace("\t", " ")


def build_gene_model_rows(path: Path) -> Dict[str, List[Tuple[int, int, str]]]:
    """Every transcript in a GFF3/GTF file as a BED12-shaped row, plus the other features.

    Transcripts are whatever exon/CDS/UTR lines name as their parent (GFF3 ``Parent``,
    GTF ``transcript_id``); their own line, where there is one, supplies the name and
    biotype, and its parent the gene. A transcript given only as CDS and UTR lines gets
    its exons from those. Genes and transcripts that were drawn as models are not drawn
    again; anything else in the file — a gene with no transcripts, a repeat, a
    regulatory feature — is kept as a plain interval.
    """
    opener = gzip.open if str(path).lower().endswith(".gz") else open
    by_id: Dict[str, Tuple[str, str, int, int, str, str, Dict[str, str]]] = {}
    gtf_transcripts: Dict[str, Tuple[str, str, int, int, str, str, Dict[str, str]]] = {}
    # GTF genes have no ID; transcripts reach theirs through gene_id instead of Parent.
    gtf_genes: Dict[str, Tuple[str, str, int, int, str, str, Dict[str, str]]] = {}
    parts: Dict[str, Dict[str, list]] = {}
    others: List[Tuple[str, str, int, int, str, str, str]] = []

    with opener(str(path), "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if line.startswith("#"):
                if line.startswith("##FASTA"):
                    break
                continue
            cols = line.rstrip("\r\n").split("\t")
            if len(cols) < 8:
                continue
            try:
                first, last = int(cols[3]), int(cols[4])
            except ValueError:
                continue
            start, end = min(first, last) - 1, max(first, last)
            ftype = cols[2]
            attrs_text = cols[8] if len(cols) > 8 else ""
            strand = cols[6] if cols[6] in ("+", "-") else "."

            if ftype in _PART_TYPES:
                # Only the parent is needed from a part line; a full attribute parse of
                # a million exons is most of the load time for nothing.
                match = _PARENT_RE.search(attrs_text)
                if match:
                    parents = [p for p in match.group(1).split(",") if p]
                else:
                    gtf = _GTF_TX_RE.search(attrs_text)
                    parents = [gtf.group(1)] if gtf else []
                if parents:
                    kind = "exon" if ftype in _EXON_TYPES else "cds" if ftype in _CDS_TYPES else "utr" if ftype in _UTR_TYPES else ""
                    for parent in parents:
                        entry = parts.get(parent)
                        if entry is None:
                            entry = parts[parent] = {"exon": [], "cds": [], "utr": [], "loc": [cols[0], strand, cols[1]], "gtf": None}
                        if kind:
                            entry[kind].append((start, end))
                        if entry["gtf"] is None and not match:
                            entry["gtf"] = attrs_text
                    continue

            if ftype in _SEQUENCE_TYPES:
                continue
            attrs = _gff_attributes(attrs_text)
            record = (cols[0], cols[1], start, end, strand, ftype, attrs)
            if attrs.get("ID"):
                by_id[attrs["ID"]] = record
            elif ftype == "transcript" and attrs.get("transcript_id"):
                gtf_transcripts[attrs["transcript_id"]] = record
            elif ftype == "gene" and attrs.get("gene_id"):
                gtf_genes[attrs["gene_id"]] = record
            others.append((cols[0], cols[1], start, end, strand, ftype, attrs_text))

    drawn_ids = set()
    # GTF genes have no ID, only gene_id; one drawn through its transcripts is skipped too.
    drawn_gene_ids = set()
    rows_by_chrom: Dict[str, List[Tuple[int, int, str]]] = {}

    for tx_id, entry in parts.items():
        tx = by_id.get(tx_id) or gtf_transcripts.get(tx_id)
        tx_attrs = tx[6] if tx else (_gff_attributes(entry["gtf"]) if entry["gtf"] else {})
        exons = _merge_intervals(entry["exon"] or (entry["cds"] + entry["utr"]))
        if not exons:
            continue
        chrom, strand, source = entry["loc"]
        ftype = tx[5] if tx else "transcript"
        if tx:
            chrom, source, strand = tx[0], tx[1], tx[4]
        tx_start = min(exons[0][0], tx[2]) if tx else exons[0][0]
        tx_end = max(exons[-1][1], tx[3]) if tx else exons[-1][1]

        gene_key = (tx_attrs.get("Parent") or "").split(",")[0]
        gene = by_id.get(gene_key) or gtf_genes.get(tx_attrs.get("gene_id") or "")
        gene_attrs = gene[6] if gene else {}
        gene_name = gene_attrs.get("Name") or tx_attrs.get("gene_name") or gene_attrs.get("gene_name") or ""
        gene_id = gene_attrs.get("gene_id") or tx_attrs.get("gene_id") or _strip_prefix(gene_key)
        transcript_id = tx_attrs.get("transcript_id") or _strip_prefix(tx_id)
        biotype = (tx_attrs.get("biotype") or tx_attrs.get("transcript_biotype") or tx_attrs.get("transcript_type")
                   or gene_attrs.get("biotype") or gene_attrs.get("gene_biotype") or gene_attrs.get("gene_type")
                   or tx_attrs.get("gene_biotype") or tx_attrs.get("gene_type") or "")
        name = tx_attrs.get("Name") or tx_attrs.get("transcript_name") or gene_name or transcript_id

        cds = entry["cds"]
        thick_start, thick_end = (min(c[0] for c in cds), max(c[1] for c in cds)) if cds else (tx_start, tx_start)
        colour = next((_item_rgb(tx_attrs[k]) for k in _COLOUR_KEYS if tx_attrs.get(k)), "")
        rest = "\t".join((
            _clean(name), "", strand, str(thick_start), str(thick_end), colour,
            str(len(exons)),
            ",".join(str(e - s) for s, e in exons) + ",",
            ",".join(str(s - tx_start) for s, _ in exons) + ",",
            _clean(gene_name), _clean(gene_id), _clean(transcript_id), _clean(biotype), ftype,
            source if source != "." else "",
        ))
        rows_by_chrom.setdefault(chrom, []).append((tx_start, tx_end, rest))
        drawn_ids.add(tx_id)
        if gene_key:
            drawn_ids.add(gene_key)
        if gene_id:
            drawn_gene_ids.add(gene_id)

    for chrom, source, start, end, strand, ftype, attrs_text in others:
        attrs = _gff_attributes(attrs_text)
        if attrs.get("ID") in drawn_ids or (ftype == "transcript" and attrs.get("transcript_id") in drawn_ids):
            continue
        if not attrs.get("ID") and ftype == "gene" and attrs.get("gene_id") in drawn_gene_ids:
            continue
        name = next((attrs[k] for k in _NAME_KEYS if attrs.get(k)), "") or ftype
        colour = next((_item_rgb(attrs[k]) for k in _COLOUR_KEYS if attrs.get(k)), "")
        rest = "\t".join((
            _clean(_strip_prefix(name)), "", strand, "", "", colour, "", "", "",
            _clean(attrs.get("gene_name") or attrs.get("Name") or ""), _clean(attrs.get("gene_id") or ""),
            "", _clean(attrs.get("biotype") or attrs.get("gene_biotype") or ""), ftype,
            source if source != "." else "",
        ))
        rows_by_chrom.setdefault(chrom, []).append((start, end, rest))
    return rows_by_chrom


def looks_like_gene_models(path: Path, max_lines: int = 20000) -> bool:
    """Whether a GFF/GTF file has transcript structure worth drawing as gene models."""
    opener = gzip.open if str(path).lower().endswith(".gz") else open
    linked = 0
    try:
        with opener(str(path), "rt", encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= max_lines:
                    break
                cols = line.split("\t", 9)
                if len(cols) < 9 or cols[2] not in (_EXON_TYPES | _CDS_TYPES):
                    continue
                if _PARENT_RE.search(cols[8]) or _GTF_TX_RE.search(cols[8]):
                    linked += 1
                    if linked >= 3:
                        return True
    except OSError:
        return False
    # A small file may have only a transcript or two; any linked exon or CDS counts.
    return linked > 0


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

    def __init__(
        self,
        path: Path,
        parse_line: Callable[[str], ParsedLine] = None,
        sql: Optional[bytes] = None,
        rows_by_chrom: Optional[Dict[str, List[Tuple[int, int, str]]]] = None,
    ):
        if rows_by_chrom is not None:
            self._sql = sql
            self._chroms = {chrom: _ChromArrays(rows) for chrom, rows in rows_by_chrom.items()}
            self.feature_count = sum(len(rows.starts) for rows in self._chroms.values())
            return
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


GENE_MODELS = "transcripts"


def get_plain_bed_index(path: Path, feature_model: str = "") -> PlainBedIndex:
    """The cached index for a BED or GFF file, rebuilt when the file changes.

    ``feature_model="transcripts"`` reads a GFF/GTF as gene models rather than one
    interval per line; the two are cached separately.
    """
    gene_models = feature_model == GENE_MODELS and is_gff_path(path)
    key = str(path.resolve()) + ("|transcripts" if gene_models else "")
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
        if gene_models:
            index = PlainBedIndex(path, sql=GENE_MODEL_AUTOSQL, rows_by_chrom=build_gene_model_rows(path))
        else:
            parse_line, sql = _parser_for(path)
            index = PlainBedIndex(path, parse_line=parse_line, sql=sql)
        with _INDEX_CACHE_LOCK:
            _INDEX_CACHE[key] = (sig, index)
            _INDEX_CACHE.move_to_end(key)
            while len(_INDEX_CACHE) > _INDEX_CACHE_MAX:
                _INDEX_CACHE.popitem(last=False)
        return index


def open_plain_bed(path: Path, feature_model: str = ""):
    """A BigBed-shaped handle on a plain BED or GFF file; the caller closes it.

    Gene models need the whole file — a transcript's exons can be anywhere in it — so
    they always come from the in-memory index, tabix or not.
    """
    if feature_model == GENE_MODELS and is_gff_path(path):
        return _NonClosing(get_plain_bed_index(path, feature_model))
    if str(path).lower().endswith(".gz") and _has_tabix_index(path):
        parse_line, sql = _parser_for(path)
        return TabixBedSource(path, parse_line=parse_line, sql=sql)
    return _NonClosing(get_plain_bed_index(path))
