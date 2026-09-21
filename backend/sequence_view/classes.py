"""What each base of a window is, expressed as runs.

Pure: plain values in, plain values out, no FastAPI and no import of ``main``.

The view never receives a class per base. A megabase of intron would be a
megabyte of the letter "i" carrying no information, so a window's description is
a list of non-overlapping runs, ascending, with gaps where nothing applies.

Coordinates are 1-based inclusive on both ends, forward strand, throughout --
including for a gene on the minus strand. Reverse reading is a display transform
the client applies to the sequence, the gutters and these runs together; a
backend that emitted them reversed would double every test here for no gain.
"""

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# Highest priority first. The same order the Feature Explorer paints in
# (frontend FeatureExplorerSequencesPanel.jsx), so that a base coloured one way
# there is coloured the same way here. It is an explicit list rather than an
# implied sort order because the day someone changes it, it should be this line
# they change.
FEATURE_PRIORITY: Tuple[str, ...] = (
    "start_codon",
    "stop_codon",
    "donor",
    "acceptor",
    "utr5",
    "utr3",
    "cds",
    "exon",
    "intron",
)

_PRIORITY_RANK = {name: index for index, name in enumerate(FEATURE_PRIORITY)}

# An exon that is neither translated nor untranslated region is exonic
# non-coding sequence -- the whole of a lncRNA, for instance. Renaming it here
# means the client never has to know that the annotation calls it "exon".
_RESIDUAL_EXON_CLASS = "noncoding"

# The five states a base can be in when every isoform of a gene is asked at once.
GENE_CLASS_CODING = "coding"
GENE_CLASS_UTR = "utr"
GENE_CLASS_NONCODING = "noncoding"
GENE_CLASS_INTRON = "intron"
GENE_CLASS_MIXED = "mixed"

LOCATION_CLASS_GENIC = "genic"
LOCATION_CLASS_INTERGENIC = "intergenic"


def _clip(start: int, end: int, low: int, high: int) -> Optional[Tuple[int, int]]:
    a = max(int(start), low)
    b = min(int(end), high)
    return (a, b) if b >= a else None


def merge_runs(runs: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Adjacent runs of the same class joined into one."""
    out: List[Dict[str, Any]] = []
    for run in sorted(runs, key=lambda r: (int(r["s"]), int(r["e"]))):
        if out and out[-1]["c"] == run["c"] and int(run["s"]) == int(out[-1]["e"]) + 1:
            out[-1]["e"] = int(run["e"])
        else:
            out.append({"s": int(run["s"]), "e": int(run["e"]), "c": str(run["c"])})
    return out


class _Painter:
    """Intervals painted highest priority first, each claiming only free bases.

    First writer wins, which is what makes the priority list above the whole of
    the overlap rule: a start codon is drawn over the CDS it sits in because it
    is painted first, not because of anything about the order it arrived in.
    """

    def __init__(self, start: int, end: int) -> None:
        self.start = int(start)
        self.end = int(end)
        self.claimed: List[Tuple[int, int]] = []
        self.runs: List[Dict[str, Any]] = []

    def _free_pieces(self, start: int, end: int) -> List[Tuple[int, int]]:
        pieces = [(start, end)]
        for taken_start, taken_end in self.claimed:
            remaining: List[Tuple[int, int]] = []
            for piece_start, piece_end in pieces:
                if taken_end < piece_start or taken_start > piece_end:
                    remaining.append((piece_start, piece_end))
                    continue
                if taken_start > piece_start:
                    remaining.append((piece_start, taken_start - 1))
                if taken_end < piece_end:
                    remaining.append((taken_end + 1, piece_end))
            pieces = remaining
            if not pieces:
                break
        return pieces

    def paint(self, start: int, end: int, name: str) -> None:
        clipped = _clip(start, end, self.start, self.end)
        if not clipped:
            return
        for piece_start, piece_end in self._free_pieces(*clipped):
            self.runs.append({"s": piece_start, "e": piece_end, "c": name})
            self.claimed.append((piece_start, piece_end))
        self.claimed.sort()

    def result(self) -> List[Dict[str, Any]]:
        return merge_runs(self.runs)


def transcript_classes(
    intervals: Iterable[Dict[str, Any]],
    start: int,
    end: int,
) -> List[Dict[str, Any]]:
    """One transcript's window described as runs.

    ``intervals`` is what ``_build_tx_feature_intervals`` returns: exons,
    introns, CDS, UTRs and the motif-verified codons and splice sites, each
    ``{type, start, end}`` in genomic 1-based inclusive coordinates.
    """
    painter = _Painter(start, end)
    ordered = sorted(
        (i for i in intervals if i.get("type") in _PRIORITY_RANK),
        key=lambda i: (_PRIORITY_RANK[i["type"]], int(i["start"])),
    )
    for interval in ordered:
        name = interval["type"]
        if name == "exon":
            name = _RESIDUAL_EXON_CLASS
        painter.paint(int(interval["start"]), int(interval["end"]), name)
    return painter.result()


def cds_frame_from_segments(segments: Iterable[Dict[str, Any]]) -> List[Dict[str, int]]:
    """Where each CDS segment sits in spliced coding sequence.

    ``segments`` is what ``_build_mode_segments(..., "cds")`` returns, in 5' to 3'
    order with ``coord_start`` 1-based in spliced CDS space. ``o`` is the 0-based
    spliced offset of the segment's lowest genomic base on the plus strand and of
    its highest on the minus -- in both cases ``coord_start - 1``, because
    ``coord_start`` already counts from the 5' end.

    The result is sorted by coordinate, like every other run list here, so the
    client can binary search it. The offsets carry the direction instead.
    """
    out: List[Dict[str, int]] = []
    for segment in segments:
        genomic_start = int(segment.get("genomic_start", 0))
        genomic_end = int(segment.get("genomic_end", 0))
        coord_start = int(segment.get("coord_start", 0))
        if genomic_end < genomic_start or coord_start < 1:
            continue
        out.append({"s": genomic_start, "e": genomic_end, "o": coord_start - 1})
    out.sort(key=lambda s: s["s"])
    return out


def _transcript_votes(
    transcript: Dict[str, Any],
    start: int,
    end: int,
) -> List[Tuple[int, int, str]]:
    """One isoform's opinion of each base it covers, as intervals.

    A transcript says nothing about bases outside its own span. That is the rule
    that keeps "mixed" meaningful: without it, the 5' region of any gene with one
    short isoform would be mixed all the way along, which tells a reader nothing.
    """
    exons = [(int(e["start"]), int(e["end"])) for e in transcript.get("exons") or []]
    if not exons:
        return []
    exons.sort()
    span_start = min(s for s, _ in exons)
    span_end = max(e for _, e in exons)
    window = _clip(span_start, span_end, start, end)
    if not window:
        return []

    painter = _Painter(*window)
    for cds in transcript.get("cds_list") or []:
        painter.paint(int(cds["start"]), int(cds["end"]), GENE_CLASS_CODING)
    for utr in transcript.get("utrs") or []:
        painter.paint(int(utr["start"]), int(utr["end"]), GENE_CLASS_UTR)
    for exon_start, exon_end in exons:
        painter.paint(exon_start, exon_end, GENE_CLASS_NONCODING)
    # Whatever is left inside the transcript's span is between its exons.
    painter.paint(window[0], window[1], GENE_CLASS_INTRON)
    return [(int(r["s"]), int(r["e"]), str(r["c"])) for r in painter.result()]


def gene_union_classes(
    transcripts: Iterable[Dict[str, Any]],
    start: int,
    end: int,
    gene_start: Optional[int] = None,
    gene_end: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """A gene's window described by every one of its isoforms at once.

    Each isoform votes on each base it covers. Bases the isoforms agree about
    take that class; bases they disagree about are "mixed"; bases no isoform
    covers are intronic, since they lie inside the gene but outside every
    transcript.

    That last rule holds only inside the gene. ``gene_start`` and ``gene_end``
    bound it, so that a reader's flanking sequence comes back with no class at
    all rather than being described as intronic -- it is not inside anything.

    Done by sweeping interval boundaries rather than by walking bases. A gene can
    be two and a half megabases long and carry a hundred isoforms, and touching
    every base once per isoform would be a quarter of a billion steps for an
    answer that only ever changes at a boundary.
    """
    low, high = int(start), int(end)
    if gene_start is not None:
        low = max(low, int(gene_start))
    if gene_end is not None:
        high = min(high, int(gene_end))
    if high < low:
        return []

    votes: List[Tuple[int, int, str]] = []
    for transcript in transcripts:
        votes.extend(_transcript_votes(transcript, low, high))

    return combine_votes(votes, low, high, GENE_CLASS_INTRON)


def combine_votes(
    votes: Sequence[Tuple[int, int, str]],
    low: int,
    high: int,
    empty_class: str,
) -> List[Dict[str, Any]]:
    """Voters agreeing about a base give it their class; disagreeing, "mixed".

    The one place that rule lives. It is applied twice -- by the isoforms of one
    gene, and by the genes of one region -- and the two must agree about what
    disagreement looks like, so they share this rather than resembling each
    other.

    Done by sweeping interval boundaries rather than by walking bases. A gene can
    be two and a half megabases long and carry a hundred isoforms, and touching
    every base once per voter would be a quarter of a billion steps for an answer
    that only ever changes at a boundary.

    ``empty_class`` is what a base with no voters is: inside a gene that is
    intronic, and between genes it is intergenic.
    """
    low, high = int(low), int(high)
    if high < low:
        return []
    if not votes:
        return [{"s": low, "e": high, "c": empty_class}]

    boundaries = {low, high + 1}
    events: Dict[int, Dict[str, int]] = {}
    for vote_start, vote_end, name in votes:
        boundaries.add(vote_start)
        boundaries.add(vote_end + 1)
        events.setdefault(vote_start, {}).setdefault(name, 0)
        events[vote_start][name] += 1
        events.setdefault(vote_end + 1, {}).setdefault(name, 0)
        events[vote_end + 1][name] -= 1

    marks = sorted(b for b in boundaries if low <= b <= high + 1)
    active: Dict[str, int] = {}
    runs: List[Dict[str, Any]] = []
    for index, position in enumerate(marks[:-1]):
        for name, delta in (events.get(position) or {}).items():
            active[name] = active.get(name, 0) + delta
            if active[name] <= 0:
                active.pop(name, None)
        span_end = marks[index + 1] - 1
        if span_end < position:
            continue
        if len(active) == 0:
            name = empty_class
        elif len(active) == 1:
            name = next(iter(active))
        else:
            name = GENE_CLASS_MIXED
        runs.append({"s": position, "e": span_end, "c": name})

    return merge_runs(runs)


def location_classes(
    genes: Iterable[Dict[str, Any]],
    start: int,
    end: int,
) -> List[Dict[str, Any]]:
    """A plain stretch of genome: which parts of it a gene sits on.

    Overlapping and nested genes are one genic run, not several -- at this
    altitude the question is whether a base is in a gene at all. Which gene, and
    where its edges are, is answered separately by the feature list, so that the
    reader can light up one gene's boundaries without the runs being refetched.
    """
    low, high = int(start), int(end)
    if high < low:
        return []

    spans: List[Tuple[int, int]] = []
    for gene in genes:
        clipped = _clip(int(gene["start"]), int(gene["end"]), low, high)
        if clipped:
            spans.append(clipped)
    spans.sort()

    runs: List[Dict[str, Any]] = []
    cursor = low
    for span_start, span_end in spans:
        if span_start > cursor:
            runs.append({"s": cursor, "e": span_start - 1, "c": LOCATION_CLASS_INTERGENIC})
            cursor = span_start
        if span_end >= cursor:
            runs.append({"s": cursor, "e": span_end, "c": LOCATION_CLASS_GENIC})
            cursor = span_end + 1
    if cursor <= high:
        runs.append({"s": cursor, "e": high, "c": LOCATION_CLASS_INTERGENIC})
    return merge_runs(runs)


def location_gene_classes(
    genes: Iterable[Dict[str, Any]],
    start: int,
    end: int,
) -> List[Dict[str, Any]]:
    """A stretch of genome described the way each gene on it describes itself.

    The same five classes a gene shows -- coding, UTR, non-coding, intronic,
    mixed -- so that reading a location and reading a gene teach the same thing,
    and zooming from one to the other changes the window rather than the
    vocabulary. Bases no gene sits on are intergenic.

    Each gene is asked first, by all of its own isoforms; then the genes are
    asked together. That two-stage shape matters where genes overlap: an
    antisense transcript's exon lying over another gene's intron is a
    disagreement between *genes*, and it comes out mixed by the same rule that
    already handles a disagreement between isoforms.

    Each gene needs ``transcripts``; a gene with none is intronic throughout its
    own span, which is what the annotation actually says about it.
    """
    low, high = int(start), int(end)
    if high < low:
        return []

    votes: List[Tuple[int, int, str]] = []
    for gene in genes:
        window = _clip(int(gene["start"]), int(gene["end"]), low, high)
        if not window:
            continue
        for run in gene_union_classes(
            gene.get("transcripts") or [],
            window[0], window[1],
            int(gene["start"]), int(gene["end"]),
        ):
            votes.append((int(run["s"]), int(run["e"]), str(run["c"])))

    return combine_votes(votes, low, high, LOCATION_CLASS_INTERGENIC)


def gene_overlap_spans(
    genes: Iterable[Dict[str, Any]],
    start: int,
    end: int,
) -> List[Dict[str, int]]:
    """Where two or more genes lie on the same base, and how many.

    Kept apart from the classes rather than made one of them. A base under two
    genes is still coding or still intronic, and overlap is common enough --
    antisense transcripts, nested genes, read-through loci -- that spending the
    colour on it would blank out the annotation over long stretches, which is the
    opposite of what looking at a location is for. So it is a second channel: the
    class says what the base is, this says how many genes claim it.
    """
    low, high = int(start), int(end)
    if high < low:
        return []

    events: Dict[int, int] = {}
    for gene in genes:
        window = _clip(int(gene["start"]), int(gene["end"]), low, high)
        if not window:
            continue
        events[window[0]] = events.get(window[0], 0) + 1
        events[window[1] + 1] = events.get(window[1] + 1, 0) - 1

    if not events:
        return []

    marks = sorted(events)
    depth = 0
    out: List[Dict[str, int]] = []
    for index, position in enumerate(marks[:-1]):
        depth += events[position]
        if depth < 2:
            continue
        span_end = marks[index + 1] - 1
        if span_end < position:
            continue
        # Adjacent stretches of the same depth are one stretch: a reader asking
        # "how many genes are here" gets one answer over the whole of it.
        if out and out[-1]["n"] == depth and out[-1]["e"] + 1 == position:
            out[-1]["e"] = span_end
        else:
            out.append({"s": position, "e": span_end, "n": depth})
    return out


def base_class_in_transcript(transcript: Dict[str, Any], coord: int) -> Optional[str]:
    """What one isoform says about one base, or None if it says nothing.

    The same decision ``_transcript_votes`` makes over a window, for a single
    coordinate -- and split one step finer: a UTR is reported as 5' or 3'
    according to which side of the CDS it lies on in reading order, because a
    reader asking about one base wants the answer the transcript view would give
    rather than the gene view's.

    None where the base is outside the transcript's own span. A transcript that
    does not cover a base has no opinion about it, which is the rule that keeps
    "mixed" meaningful, and it must be the same rule here or the box would
    explain a colour by listing isoforms that did not vote for it.
    """
    at = int(coord)
    exons = [(int(e["start"]), int(e["end"])) for e in transcript.get("exons") or []]
    if not exons:
        return None
    if at < min(s for s, _ in exons) or at > max(e for _, e in exons):
        return None

    cds = [(int(c["start"]), int(c["end"])) for c in transcript.get("cds_list") or []]
    for low, high in cds:
        if low <= at <= high:
            return GENE_CLASS_CODING

    in_utr = any(
        int(u["start"]) <= at <= int(u["end"]) for u in transcript.get("utrs") or []
    )
    if in_utr and cds:
        strand = str(transcript.get("strand") or "+")
        before = at < min(low for low, _ in cds)
        if strand == "-":
            before = at > max(high for _, high in cds)
        return "utr5" if before else "utr3"
    if in_utr:
        # Untranslated by name, but with no CDS to be untranslated relative to,
        # so the honest answer is the one the gene view gives.
        return _RESIDUAL_EXON_CLASS

    for low, high in exons:
        if low <= at <= high:
            return _RESIDUAL_EXON_CLASS
    return GENE_CLASS_INTRON


def project_to_spliced(
    segments: Sequence[Dict[str, Any]],
    strand: str,
    start: int,
    end: int,
) -> List[Tuple[int, int]]:
    """Where a genomic stretch lands in a spliced sequence, as ranges.

    ``segments`` is what ``_build_mode_segments`` returns: 5' to 3' order, each
    with ``coord_start``/``coord_end`` in spliced 1-based space and
    ``genomic_start``/``genomic_end`` in genomic 1-based space, both inclusive.

    A stretch can land in several segments -- an intron-spanning CDS is the
    ordinary case -- so the answer is a list. It can also land in none, which is
    what an intron does: an intron is exactly the sequence a spliced transcript
    has taken out, so projecting one is meant to give nothing rather than to
    fail.

    On the minus strand the spliced offset falls as the genomic coordinate
    rises, which is the one thing here that is not the same arithmetic on both
    strands. The ranges come back ascending in *spliced* space on both, because
    that is the space everything downstream reads them in.
    """
    low = min(int(start), int(end))
    high = max(int(start), int(end))
    reverse = str(strand) == "-"
    out: List[Tuple[int, int]] = []
    for segment in segments:
        g_low = int(segment["genomic_start"])
        g_high = int(segment["genomic_end"])
        if g_high < g_low:
            g_low, g_high = g_high, g_low
        piece = _clip(low, high, g_low, g_high)
        if not piece:
            continue
        a, b = piece
        base = int(segment["coord_start"])
        if reverse:
            out.append((base + (g_high - b), base + (g_high - a)))
        else:
            out.append((base + (a - g_low), base + (b - g_low)))
    out.sort()
    return out


def spliced_classes(
    intervals: Iterable[Dict[str, Any]],
    segments: Sequence[Dict[str, Any]],
    strand: str,
    length: int,
) -> List[Dict[str, Any]]:
    """One transcript's *spliced* sequence described as runs.

    The same intervals ``transcript_classes`` paints genomically, projected into
    spliced space first and then painted by the same priority order -- rather
    than painted genomically and the runs projected afterwards. Painting first
    would decide precedence between features that are adjacent on the genome and
    may be far apart once the introns are gone, and the reader is looking at the
    spliced sequence.

    An interval that projects to nothing simply contributes nothing, which is
    what makes introns and splice sites drop out here without a special case:
    neither is in the sequence being described.
    """
    span = max(0, int(length))
    if span <= 0:
        return []
    painter = _Painter(1, span)
    ordered = sorted(
        (i for i in intervals if i.get("type") in _PRIORITY_RANK),
        key=lambda i: (_PRIORITY_RANK[i["type"]], int(i["start"])),
    )
    for interval in ordered:
        name = interval["type"]
        if name == "exon":
            name = _RESIDUAL_EXON_CLASS
        for piece_start, piece_end in project_to_spliced(
            segments, strand, int(interval["start"]), int(interval["end"]),
        ):
            painter.paint(piece_start, piece_end, name)
    return painter.result()
