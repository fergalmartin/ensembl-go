"""Detect the flavour of an annotation file and parse its attribute column.

The three shapes we need to read:

    GFF3   ID=gene1;Parent=x;Name=foo          (percent-encoded, ``,`` = multi-value)
    GTF    gene_id "g1"; transcript_id "g1.t1";
    bare   g1                                  (AUGUSTUS native, gene/transcript rows)

AUGUSTUS mixes the last two inside one file, so parsing is decided per line from
the column's own shape, with the file-level sniff used only for reporting and for
choosing which identifier attributes carry the hierarchy.
"""

from __future__ import annotations

import gzip
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Dict, IO, Iterator, List, Optional, Tuple
from urllib.parse import unquote

GFF3 = "gff3"
GTF = "gtf"
GFF2 = "gff2"
UNKNOWN = "unknown"

#: Key used to expose an attribute column that is a single bare token.
BARE_ATTRIBUTE_KEY = "_bare"

#: Number of data lines inspected when sniffing.
SNIFF_LINE_LIMIT = 500

_GFF3_PAIR_RE = re.compile(r"^[^\s=;]+=")
_GTF_PAIR_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_.:-]*\s+("|\S)')
_BARE_TOKEN_RE = re.compile(r"^[^\s=;\"]+$")

#: GFF3 attribute keys whose value is a comma-separated list.
_MULTI_VALUE_KEYS = frozenset({"Parent", "Alias", "Dbxref", "Ontology_term", "Note", "tag"})

#: Case-insensitive aliases for the canonical GFF3 keys, since some producers
#: lower-case them.
_CANONICAL_KEYS = ("ID", "Parent", "Name", "Alias", "Note", "Dbxref", "Ontology_term", "Target")


@dataclass
class DialectInfo:
    """What a sniff pass concluded about a file."""

    dialect: str = UNKNOWN
    compression: str = "none"          # none | gzip | bgzip
    gff_version: str = ""              # value of the ##gff-version pragma
    producers: List[str] = field(default_factory=list)   # distinct column-2 values
    feature_types: List[str] = field(default_factory=list)
    lines_sniffed: int = 0
    gff3_pair_lines: int = 0
    gtf_pair_lines: int = 0
    bare_lines: int = 0
    has_fasta_directive: bool = False
    malformed_lines: int = 0
    #: Best-effort guess at the tool that wrote the file.
    producer_guess: str = ""

    def as_dict(self) -> Dict[str, object]:
        return {
            "dialect": self.dialect,
            "compression": self.compression,
            "gff_version": self.gff_version,
            "producers": list(self.producers),
            "feature_types": list(self.feature_types),
            "lines_sniffed": self.lines_sniffed,
            "gff3_pair_lines": self.gff3_pair_lines,
            "gtf_pair_lines": self.gtf_pair_lines,
            "bare_lines": self.bare_lines,
            "has_fasta_directive": self.has_fasta_directive,
            "malformed_lines": self.malformed_lines,
            "producer_guess": self.producer_guess,
        }


# ── file access ─────────────────────────────────────────────────────────────

def detect_compression(path: str) -> str:
    """Return ``none``, ``gzip`` or ``bgzip`` by reading the file header."""
    try:
        with open(path, "rb") as handle:
            header = handle.read(4)
    except OSError:
        return "none"
    if header[:2] != b"\x1f\x8b":
        return "none"
    # bgzip sets the FEXTRA flag (0x04) in the gzip header.
    return "bgzip" if header[:4] == b"\x1f\x8b\x08\x04" else "gzip"


def open_annotation_text(path: str) -> IO:
    """Open an annotation file for text reading, transparently un-gzipping.

    Detection is by content rather than extension: users routinely hand us a
    ``.gff3`` that is really gzipped, or a ``.gz`` that is not.
    """
    if detect_compression(path) == "none":
        return open(path, "rt", encoding="utf-8", errors="replace")
    return gzip.open(path, "rt", encoding="utf-8", errors="replace")


def _compressed_position(handle: IO) -> int:
    """Best-effort byte position for plain and gzip-backed text handles."""
    try:
        buffer = getattr(handle, "buffer", None)
        raw = getattr(buffer, "fileobj", None)
        if raw is not None:
            return int(raw.tell())
        if buffer is not None:
            return int(buffer.tell())
        return int(handle.tell())
    except (AttributeError, OSError, TypeError, ValueError):
        return 0


def iter_data_lines(
    path: str,
    progress_callback: Optional[Callable[[int, int], None]] = None,
) -> Iterator[Tuple[int, str]]:
    """Yield ``(line_number, line)`` for annotation records only.

    Comments, blank lines and everything at or after a ``##FASTA`` directive are
    skipped. Line numbers are 1-based and refer to the decompressed file.
    """
    total_bytes = max(0, os.path.getsize(path))
    next_report = 0
    with open_annotation_text(path) as handle:
        for line_no, raw in enumerate(handle, start=1):
            if progress_callback and line_no >= next_report:
                progress_callback(_compressed_position(handle), total_bytes)
                next_report = line_no + 250
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            if line.startswith("#"):
                if line.strip().upper().startswith("##FASTA"):
                    if progress_callback:
                        progress_callback(total_bytes, total_bytes)
                    return
                continue
            yield line_no, line
    if progress_callback:
        progress_callback(total_bytes, total_bytes)


# ── attribute parsing ───────────────────────────────────────────────────────

def _split_unquoted(text: str, separator: str = ";") -> List[str]:
    """Split on ``separator`` while ignoring separators inside double quotes."""
    parts: List[str] = []
    buf: List[str] = []
    in_quotes = False
    for ch in text:
        if ch == '"':
            in_quotes = not in_quotes
            buf.append(ch)
        elif ch == separator and not in_quotes:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    parts.append("".join(buf))
    return parts


def _column_shape(attr_text: str) -> str:
    """Classify a single attribute column as gff3-ish, gtf-ish or bare."""
    token = attr_text.strip()
    if not token or token == ".":
        return UNKNOWN
    for chunk in _split_unquoted(token):
        chunk = chunk.strip()
        if not chunk:
            continue
        if _GFF3_PAIR_RE.match(chunk):
            return GFF3
        if _GTF_PAIR_RE.match(chunk):
            return GTF
    if _BARE_TOKEN_RE.match(token):
        return "bare"
    return UNKNOWN


def parse_attributes(attr_text: str, dialect: str = UNKNOWN) -> Dict[str, str]:
    """Parse an attribute column into a flat ``{key: value}`` dict.

    The column's own shape wins over ``dialect``; the argument only breaks ties
    for columns that could be read either way. A column that is a single bare
    token (AUGUSTUS ``g1.t1``) is returned as ``{BARE_ATTRIBUTE_KEY: token}``.

    GFF3 values are percent-decoded. GTF values are unquoted. Multi-value keys
    keep their commas — use :func:`attr_list` to split them.
    """
    text = (attr_text or "").strip()
    if not text or text == ".":
        return {}

    shape = _column_shape(text)
    if shape == "bare":
        return {BARE_ATTRIBUTE_KEY: text}
    if shape == UNKNOWN:
        shape = dialect if dialect in (GFF3, GTF, GFF2) else GFF3
    if shape == GFF2:
        shape = GTF

    attrs: Dict[str, str] = {}
    for chunk in _split_unquoted(text):
        chunk = chunk.strip()
        if not chunk:
            continue
        if shape == GFF3 and "=" in chunk:
            key, _, value = chunk.partition("=")
            key = key.strip()
            if not key:
                continue
            attrs.setdefault(key, unquote(value.strip()))
            continue
        # GTF: `key "value"` or `key value`, tolerating repeated whitespace.
        match = re.match(r'^(\S+)\s+(.*)$', chunk)
        if match:
            key = match.group(1).strip()
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
                value = value[1:-1]
            if key:
                attrs.setdefault(key, value)
            continue
        if "=" in chunk:
            key, _, value = chunk.partition("=")
            if key.strip():
                attrs.setdefault(key.strip(), unquote(value.strip()))
    return attrs


def attr_get(attrs: Dict[str, str], *keys: str) -> str:
    """First non-empty value among ``keys``, matched case-insensitively."""
    if not attrs:
        return ""
    for key in keys:
        value = attrs.get(key)
        if value:
            return value
    lowered = {k.lower(): v for k, v in attrs.items()}
    for key in keys:
        value = lowered.get(key.lower())
        if value:
            return value
    return ""


def attr_list(attrs: Dict[str, str], *keys: str) -> List[str]:
    """Comma-separated multi-value lookup (``Parent=a,b`` -> ``['a', 'b']``)."""
    raw = attr_get(attrs, *keys)
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def attr_first(attrs: Dict[str, str], *keys: str) -> str:
    """First element of a multi-value attribute, or ``''``."""
    values = attr_list(attrs, *keys)
    return values[0] if values else ""


def normalize_multi_value(key: str, value: str) -> str:
    """Collapse whitespace around commas for keys we know are lists."""
    if key in _MULTI_VALUE_KEYS and "," in value:
        return ",".join(part.strip() for part in value.split(",") if part.strip())
    return value


# ── sniffing ────────────────────────────────────────────────────────────────

_PRODUCER_HINTS = (
    ("stringtie", "StringTie"),
    ("scallop", "Scallop"),
    ("augustus", "AUGUSTUS"),
    ("braker", "BRAKER"),
    ("genemark", "GeneMark"),
    ("tiberius", "Tiberius"),
    ("helixer", "Helixer"),
    ("gnomon", "NCBI Gnomon"),
    ("refseq", "RefSeq"),
    ("bestrefseq", "RefSeq"),
    ("ensembl", "Ensembl"),
    ("havana", "Ensembl/Havana"),
    ("maker", "MAKER"),
    ("liftoff", "Liftoff"),
    ("miniprot", "miniprot"),
    ("cufflinks", "Cufflinks"),
)


def _guess_producer(producers: List[str], feature_types: List[str]) -> str:
    joined = " ".join(producers).lower()
    for needle, label in _PRODUCER_HINTS:
        if needle in joined:
            return label
    if "AUGUSTUS" in producers and "transcript" in feature_types:
        return "AUGUSTUS"
    return ""


def sniff_annotation(path: str, line_limit: int = SNIFF_LINE_LIMIT) -> DialectInfo:
    """Inspect the head of a file and decide how it should be parsed."""
    info = DialectInfo(compression=detect_compression(path))

    producers: Dict[str, int] = {}
    feature_types: Dict[str, int] = {}

    with open_annotation_text(path) as handle:
        for raw in handle:
            line = raw.rstrip("\r\n")
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("#"):
                if stripped.upper().startswith("##FASTA"):
                    info.has_fasta_directive = True
                    break
                if stripped.lower().startswith("##gff-version"):
                    parts = stripped.split()
                    if len(parts) > 1:
                        info.gff_version = parts[1]
                continue

            fields = line.split("\t")
            if len(fields) < 9:
                info.malformed_lines += 1
                if info.lines_sniffed >= line_limit:
                    break
                continue

            info.lines_sniffed += 1
            producers[fields[1]] = producers.get(fields[1], 0) + 1
            feature_types[fields[2]] = feature_types.get(fields[2], 0) + 1

            shape = _column_shape(fields[8])
            if shape == GFF3:
                info.gff3_pair_lines += 1
            elif shape == GTF:
                info.gtf_pair_lines += 1
            elif shape == "bare":
                info.bare_lines += 1

            if info.lines_sniffed >= line_limit:
                break

    info.producers = sorted(producers, key=lambda k: (-producers[k], k))
    info.feature_types = sorted(feature_types, key=lambda k: (-feature_types[k], k))

    if info.gff_version.startswith("3"):
        info.dialect = GFF3
    elif info.gff3_pair_lines > info.gtf_pair_lines:
        info.dialect = GFF3
    elif info.gtf_pair_lines or info.bare_lines:
        # A bare-token column only ever occurs in AUGUSTUS-family GTF output.
        info.dialect = GTF
    elif info.lines_sniffed:
        info.dialect = GFF2
    else:
        info.dialect = UNKNOWN

    info.producer_guess = _guess_producer(info.producers, info.feature_types)
    return info
