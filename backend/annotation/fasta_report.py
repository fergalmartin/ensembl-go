"""Streaming FASTA scanner for the genome validation report.

Counts are gathered with ``bytes.count`` over whole lines rather than per
character, so a multi-gigabyte assembly stays I/O bound. Ambiguity codes are
only broken out for lines that actually contain something outside ACGTN, which
is rare enough that the slow path almost never runs.
"""

from __future__ import annotations

import gzip
import os
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Dict, IO, List, Optional, Tuple

from .dialect import detect_compression
from .issues import ERROR, WARNING, Issue, IssueCollector

#: Unambiguous bases, counted on the fast path.
_ACGT = (b"A", b"C", b"G", b"T")
#: IUPAC ambiguity codes broken out individually in the report.
_AMBIGUITY = (b"R", b"Y", b"S", b"W", b"K", b"M", b"B", b"D", b"H", b"V")

#: Sequences retained by name in the payload; the rest are counted only.
_MAX_NAMED_SEQUENCES = 200


@dataclass
class SequenceStat:
    name: str
    length: int
    description: str = ""

    def as_dict(self) -> Dict[str, object]:
        return {"name": self.name, "length": self.length, "description": self.description}


@dataclass
class FastaReport:
    path: str = ""
    compression: str = "none"
    file_size_bytes: int = 0

    sequence_count: int = 0
    total_length: int = 0
    longest_length: int = 0
    shortest_length: int = 0
    mean_length: float = 0.0
    median_length: int = 0
    n50: int = 0
    l50: int = 0
    n90: int = 0
    l90: int = 0

    #: Base -> count, upper-cased. Includes ``N`` and any IUPAC code present.
    base_counts: Dict[str, int] = field(default_factory=dict)
    #: Characters outside the IUPAC alphabet, if any.
    invalid_counts: Dict[str, int] = field(default_factory=dict)
    gc_percent: float = 0.0
    gc_percent_including_ambiguity: float = 0.0
    n_percent: float = 0.0
    ambiguity_percent: float = 0.0
    softmasked_bases: int = 0
    softmasked_percent: float = 0.0
    all_n_sequences: int = 0
    empty_sequences: int = 0

    longest_sequences: List[SequenceStat] = field(default_factory=list)
    duplicate_names: List[str] = field(default_factory=list)
    names_with_whitespace: int = 0

    fai_present: bool = False
    fai_creatable: bool = True
    usable_by_pysam: bool = True
    decompression_required: bool = False
    estimated_decompressed_bytes: int = 0

    issues: List[Issue] = field(default_factory=list)

    def as_dict(self) -> Dict[str, object]:
        return {
            "path": self.path,
            "compression": self.compression,
            "file_size_bytes": self.file_size_bytes,
            "sequence_count": self.sequence_count,
            "total_length": self.total_length,
            "longest_length": self.longest_length,
            "shortest_length": self.shortest_length,
            "mean_length": round(self.mean_length, 2),
            "median_length": self.median_length,
            "n50": self.n50,
            "l50": self.l50,
            "n90": self.n90,
            "l90": self.l90,
            "base_counts": dict(self.base_counts),
            "invalid_counts": dict(self.invalid_counts),
            "gc_percent": round(self.gc_percent, 3),
            "gc_percent_including_ambiguity": round(self.gc_percent_including_ambiguity, 3),
            "n_percent": round(self.n_percent, 3),
            "ambiguity_percent": round(self.ambiguity_percent, 3),
            "softmasked_bases": self.softmasked_bases,
            "softmasked_percent": round(self.softmasked_percent, 3),
            "all_n_sequences": self.all_n_sequences,
            "empty_sequences": self.empty_sequences,
            "longest_sequences": [s.as_dict() for s in self.longest_sequences],
            "duplicate_names": list(self.duplicate_names),
            "names_with_whitespace": self.names_with_whitespace,
            "fai_present": self.fai_present,
            "fai_creatable": self.fai_creatable,
            "usable_by_pysam": self.usable_by_pysam,
            "decompression_required": self.decompression_required,
            "estimated_decompressed_bytes": self.estimated_decompressed_bytes,
            "issues": [i.as_dict() for i in self.issues],
        }


def _open_binary(path: str, compression: str) -> IO:
    if compression == "none":
        return open(path, "rb")
    return gzip.open(path, "rb")


def _percentile_length(sorted_desc: List[int], total: int, fraction: float) -> Tuple[int, int]:
    """Return ``(Nxx, Lxx)`` for the given cumulative fraction of total length."""
    if not sorted_desc or total <= 0:
        return 0, 0
    target = total * fraction
    cumulative = 0
    for index, length in enumerate(sorted_desc, start=1):
        cumulative += length
        if cumulative >= target:
            return length, index
    return sorted_desc[-1], len(sorted_desc)


def scan_fasta(
    path: str,
    progress_callback: Optional[Callable[[int, int], None]] = None,
    example_limit: int = 20,
) -> FastaReport:
    """Read a FASTA end to end and summarise it.

    ``progress_callback(bytes_read, total_bytes)`` is invoked periodically so a
    background task can report progress on large assemblies.
    """
    compression = detect_compression(path)
    report = FastaReport(path=path, compression=compression)
    issues = IssueCollector(example_limit=example_limit)

    try:
        report.file_size_bytes = os.path.getsize(path)
    except OSError:
        report.file_size_bytes = 0

    lengths: List[int] = []
    named: List[SequenceStat] = []
    seen_names: Dict[str, int] = {}
    base_counter: Counter = Counter()
    invalid_counter: Counter = Counter()
    softmasked = 0

    current_name = ""
    current_length = 0
    current_n = 0
    current_line_length = -1
    current_line_length_varies = False
    current_has_short_line = False

    def _finish_current() -> None:
        nonlocal current_length, current_n, current_line_length, current_line_length_varies
        nonlocal current_has_short_line
        if not current_name:
            return
        lengths.append(current_length)
        if len(named) < _MAX_NAMED_SEQUENCES:
            named.append(SequenceStat(name=current_name, length=current_length))
        if current_length == 0:
            report.empty_sequences += 1
            issues.add(
                "empty_sequence",
                WARNING,
                "Sequence record has no bases.",
                example=current_name,
            )
        elif current_n == current_length:
            report.all_n_sequences += 1
        if current_line_length_varies:
            issues.add(
                "inconsistent_line_length",
                ERROR,
                "Sequence lines within a record have differing lengths, which "
                "prevents a .fai index from being built.",
                example=current_name,
            )
        current_length = 0
        current_n = 0
        current_line_length = -1
        current_line_length_varies = False
        current_has_short_line = False

    bytes_read = 0
    progress_every = 64 * 1024 * 1024
    next_progress = progress_every

    with _open_binary(path, compression) as handle:
        for raw in handle:
            bytes_read += len(raw)
            if progress_callback and bytes_read >= next_progress:
                progress_callback(bytes_read, report.file_size_bytes)
                next_progress = bytes_read + progress_every

            if raw.startswith(b">"):
                _finish_current()
                header = raw[1:].rstrip(b"\r\n").decode("utf-8", "replace")
                name, _, description = header.partition(" ")
                name = name.strip()
                current_name = name
                if description.strip():
                    report.names_with_whitespace += 1
                if not name:
                    issues.add(
                        "unnamed_sequence",
                        ERROR,
                        "FASTA header has no sequence name.",
                        example=header[:60],
                    )
                seen = seen_names.get(name)
                if seen:
                    seen_names[name] = seen + 1
                    if name not in report.duplicate_names and len(report.duplicate_names) < 50:
                        report.duplicate_names.append(name)
                    issues.add(
                        "duplicate_sequence_name",
                        ERROR,
                        "The same sequence name appears more than once; only the "
                        "first record would be reachable.",
                        example=name,
                    )
                else:
                    seen_names[name] = 1
                report.sequence_count += 1
                continue

            line = raw.rstrip(b"\r\n")
            if not line:
                continue
            if not current_name:
                issues.add(
                    "sequence_before_header",
                    ERROR,
                    "Sequence data appears before any '>' header line.",
                )
                continue

            length = len(line)

            # faidx requires a uniform line length within a record, with only the
            # final line allowed to be shorter.
            if current_line_length < 0:
                current_line_length = length
            elif current_has_short_line:
                current_line_length_varies = True
            elif length > current_line_length:
                current_line_length_varies = True
            elif length < current_line_length:
                current_has_short_line = True

            current_length += length

            upper = line.upper()
            # Soft-masked bases are written lower-case by RepeatMasker/WindowMasker.
            softmasked += sum(line.count(bytes([c])) for c in b"acgtnryswkmbdhv")

            counted = 0
            for base in _ACGT:
                hits = upper.count(base)
                if hits:
                    base_counter[base.decode()] += hits
                    counted += hits
            n_hits = upper.count(b"N")
            if n_hits:
                base_counter["N"] += n_hits
                current_n += n_hits
                counted += n_hits

            if counted != length:
                # Slow path only for lines carrying ambiguity codes or junk.
                for base in _AMBIGUITY:
                    hits = upper.count(base)
                    if hits:
                        base_counter[base.decode()] += hits
                        counted += hits
                if counted != length:
                    known = set(b"ACGTN") | set(b"RYSWKMBDHV")
                    for byte_value, hits in Counter(upper).items():
                        if byte_value not in known:
                            invalid_counter[chr(byte_value)] += hits
                    issues.add(
                        "invalid_base_characters",
                        ERROR,
                        "Sequence contains characters outside the IUPAC nucleotide alphabet.",
                        example="{0} near offset {1}".format(current_name, current_length),
                        increment=length - counted,
                    )

    _finish_current()

    # Derived statistics.
    if lengths:
        total = sum(lengths)
        report.total_length = total
        report.longest_length = max(lengths)
        report.shortest_length = min(lengths)
        report.mean_length = total / float(len(lengths))
        ordered = sorted(lengths)
        mid = len(ordered) // 2
        report.median_length = (
            ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) // 2
        )
        descending = sorted(lengths, reverse=True)
        report.n50, report.l50 = _percentile_length(descending, total, 0.5)
        report.n90, report.l90 = _percentile_length(descending, total, 0.9)

    report.base_counts = dict(sorted(base_counter.items()))
    report.invalid_counts = dict(sorted(invalid_counter.items()))
    report.softmasked_bases = softmasked

    acgt = sum(base_counter.get(b, 0) for b in ("A", "C", "G", "T"))
    gc = base_counter.get("G", 0) + base_counter.get("C", 0)
    ambiguous = sum(base_counter.get(c.decode(), 0) for c in _AMBIGUITY)
    total_bases = report.total_length or 1
    report.gc_percent = (gc / float(acgt) * 100.0) if acgt else 0.0
    report.gc_percent_including_ambiguity = gc / float(total_bases) * 100.0
    report.n_percent = base_counter.get("N", 0) / float(total_bases) * 100.0
    report.ambiguity_percent = ambiguous / float(total_bases) * 100.0
    report.softmasked_percent = softmasked / float(total_bases) * 100.0

    report.longest_sequences = sorted(named, key=lambda s: -s.length)[:20]

    # Fitness for use by pysam / the browser.
    fai_path = path + ".fai"
    report.fai_present = os.path.exists(fai_path)
    if compression == "gzip":
        # pysam cannot read plain gzip; main.ensure_fasta_index silently writes a
        # full decompressed copy next to it, so warn about the disk cost up front.
        report.usable_by_pysam = False
        report.decompression_required = True
        report.estimated_decompressed_bytes = report.total_length + report.sequence_count * 80
        issues.add(
            "plain_gzip_fasta",
            WARNING,
            "This FASTA is plain gzip, which cannot be read directly. A "
            "decompressed copy of about {0:.1f} GB will be written next to it on "
            "first use. Re-compressing with bgzip avoids this.".format(
                report.estimated_decompressed_bytes / 1e9
            ),
        )

    if report.sequence_count == 0:
        issues.add("no_sequences", ERROR, "No FASTA records were found in this file.")

    if issues.count_for("inconsistent_line_length") or issues.count_for("duplicate_sequence_name"):
        report.fai_creatable = False

    report.issues = issues.to_list()
    return report


def sequence_lengths_from_report(report: FastaReport) -> Dict[str, int]:
    """Name -> length for the sequences retained by name.

    Only usable for cross-checks on assemblies below ``_MAX_NAMED_SEQUENCES``
    records; :func:`read_sequence_lengths` is the complete version.
    """
    return {stat.name: stat.length for stat in report.longest_sequences}


def read_sequence_lengths(
    path: str,
    progress_callback: Optional[Callable[[int, int, int], None]] = None,
) -> Dict[str, int]:
    """Return every ``{sequence_name: length}`` in a FASTA.

    Uses the ``.fai`` when one exists, otherwise streams the file. This is what
    the annotation cross-checks need, and it is kept separate from
    :func:`scan_fasta` so a validation run can reuse an existing index cheaply.
    """
    fai_path = path + ".fai"
    total_bytes = 0
    try:
        total_bytes = os.path.getsize(path)
    except OSError:
        pass
    if os.path.exists(fai_path):
        lengths: Dict[str, int] = {}
        try:
            with open(fai_path, "rt", encoding="utf-8", errors="replace") as handle:
                for line in handle:
                    fields = line.rstrip("\n").split("\t")
                    if len(fields) >= 2:
                        try:
                            lengths[fields[0]] = int(fields[1])
                        except ValueError:
                            continue
                    if progress_callback and len(lengths) % 1000 == 0:
                        progress_callback(0, total_bytes, len(lengths))
            if lengths:
                if progress_callback:
                    progress_callback(total_bytes, total_bytes, len(lengths))
                return lengths
        except OSError:
            pass

    lengths = {}
    compression = detect_compression(path)
    name = ""
    length = 0
    bytes_read = 0
    next_progress = 16 * 1024 * 1024
    with _open_binary(path, compression) as handle:
        for raw in handle:
            bytes_read += len(raw)
            if raw.startswith(b">"):
                if name:
                    lengths[name] = length
                header = raw[1:].rstrip(b"\r\n").decode("utf-8", "replace")
                name = header.partition(" ")[0].strip()
                length = 0
            else:
                length += len(raw.rstrip(b"\r\n"))
            if progress_callback and bytes_read >= next_progress:
                progress_callback(bytes_read, total_bytes, len(lengths))
                next_progress = bytes_read + 16 * 1024 * 1024
    if name:
        lengths[name] = length
    if progress_callback:
        progress_callback(max(bytes_read, total_bytes), total_bytes, len(lengths))
    return lengths
