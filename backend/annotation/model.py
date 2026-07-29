"""The canonical gene / transcript / exon model every input is mapped onto.

Coordinates are 1-based inclusive throughout, matching GFF3 and the existing
SQLite index, so nothing has to be re-based when these objects are emitted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple


@dataclass
class Block:
    """One exon, CDS chunk or UTR chunk."""

    start: int
    end: int
    phase: Optional[int] = None
    #: Stable identifier, assigned when identifiers are minted. Exons that are
    #: shared between isoforms of a gene deliberately share one id, matching the
    #: Ensembl model where an exon is an object in its own right.
    feature_id: str = ""

    @property
    def length(self) -> int:
        return max(0, self.end - self.start + 1)

    def as_tuple(self) -> Tuple[int, int]:
        return (self.start, self.end)


@dataclass
class Transcript:
    transcript_id: str
    gene_id: str
    seqid: str
    start: int
    end: int
    strand: str
    source: str = "."
    feature_type: str = "mRNA"
    exons: List[Block] = field(default_factory=list)
    cds: List[Block] = field(default_factory=list)
    utr5: List[Block] = field(default_factory=list)
    utr3: List[Block] = field(default_factory=list)
    biotype: str = ""
    biotype_rule: str = ""
    source_biotype: str = ""
    is_canonical: bool = False
    tags: List[str] = field(default_factory=list)
    source_id: str = ""
    attributes: Dict[str, str] = field(default_factory=dict)
    #: Structural repairs applied, e.g. ``exons_from_cds``, ``utrs_computed``.
    inferred: List[str] = field(default_factory=list)

    @property
    def mature_length(self) -> int:
        return sum(block.length for block in self.exons)

    @property
    def cds_length(self) -> int:
        return sum(block.length for block in self.cds)

    @property
    def is_coding(self) -> bool:
        return bool(self.cds)

    def note(self, tag: str) -> None:
        if tag not in self.inferred:
            self.inferred.append(tag)


@dataclass
class Gene:
    gene_id: str
    seqid: str
    start: int
    end: int
    strand: str
    source: str = "."
    feature_type: str = "gene"
    name: str = ""
    description: str = ""
    biotype: str = ""
    source_biotype: str = ""
    source_id: str = ""
    transcripts: List[Transcript] = field(default_factory=list)
    attributes: Dict[str, str] = field(default_factory=dict)
    inferred: List[str] = field(default_factory=list)

    def note(self, tag: str) -> None:
        if tag not in self.inferred:
            self.inferred.append(tag)

    @property
    def canonical_transcript(self) -> Optional[Transcript]:
        for transcript in self.transcripts:
            if transcript.is_canonical:
                return transcript
        return self.transcripts[0] if self.transcripts else None


def merge_intervals(intervals: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """Merge overlapping/adjacent 1-based inclusive intervals."""
    ordered = sorted((int(s), int(e)) for s, e in intervals if e >= s)
    if not ordered:
        return []
    merged: List[Tuple[int, int]] = [ordered[0]]
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end + 1:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def subtract_interval(
    blocks: Sequence[Tuple[int, int]],
    hole_start: int,
    hole_end: int,
) -> Tuple[List[Tuple[int, int]], List[Tuple[int, int]]]:
    """Split ``blocks`` around ``[hole_start, hole_end]``.

    Returns ``(left_of_hole, right_of_hole)`` — used to derive UTRs by removing
    the CDS envelope from the exon blocks.
    """
    left: List[Tuple[int, int]] = []
    right: List[Tuple[int, int]] = []
    for start, end in blocks:
        if end < hole_start:
            left.append((start, end))
            continue
        if start > hole_end:
            right.append((start, end))
            continue
        if start < hole_start:
            left.append((start, hole_start - 1))
        if end > hole_end:
            right.append((hole_end + 1, end))
    return left, right
