"""Finding a pattern in a region, however large the region is.

Separated from the router the way ``spans`` and ``windows`` are: the awkward
part here is not the HTTP but the walk -- a region in focus can be a whole
chromosome, and a scan that held one would cost this process a quarter of a
gigabyte for one request. So the region is walked in blocks, and the only things
that can go wrong are about where the blocks meet.

Coordinates are 1-based inclusive on both ends, as everywhere else in this
package. Offsets, which are what this module works in, are 0-based along the
sequence *as displayed* -- so on a region the reader has turned round, offset 0
is the region's last base. ``matches_in_region`` converts back before returning.
"""

import re
from typing import Callable, Dict, List, NamedTuple, Optional, Tuple

from .windows import FIND_OVERLAP_BP, FIND_SCAN_BP, MAX_FIND_MATCHES


class Pattern(NamedTuple):
    """One thing to look for, ready to look for it with."""

    id: str
    expression: "re.Pattern"


class FindResult(NamedTuple):
    # `[start, end, pattern_id]`, genomic, 1-based inclusive, ascending.
    matches: List[List[object]]
    # Exact, whether or not every position is listed.
    total: int
    truncated: bool
    counts: Dict[str, int]


def compile_pattern(pattern: str, kind: str) -> "re.Pattern":
    """A pattern as a case-insensitive expression.

    Case-insensitive because sequence is written in both: soft-masked repeats
    are lower case and everything else is upper, and a reader looking for ATG
    means the bases rather than the typography.

    A literal is escaped rather than trusted. Sequence patterns are full of
    characters a regex reads as syntax -- `.` and `[` and `?` are all in the
    IUPAC vocabulary -- and a reader who chose "String" has said they do not
    want them read that way.
    """
    source = pattern if kind == "regex" else re.escape(pattern)
    return re.compile(source, re.IGNORECASE)


def scan_offsets(
    read: Callable[[int, int], str],
    span: int,
    patterns: List[Pattern],
    *,
    limit: int = MAX_FIND_MATCHES,
    scan_bp: int = FIND_SCAN_BP,
    overlap_bp: int = FIND_OVERLAP_BP,
) -> Tuple[List[Tuple[int, int, str]], int, bool, Dict[str, int]]:
    """Every match along ``span`` characters, as `(start, end, id)` offsets.

    ``read(at, stop)`` returns the displayed characters in the half-open offset
    range, and is the only thing that knows which way round the sequence is or
    where it came from.

    **The seam is the whole of the difficulty.** A match lying across a block
    boundary would be found by neither block: the first runs out before the
    pattern ends and the second starts after it began. So each block reaches
    back into the one before it by ``overlap_bp``, which makes the seam
    invisible -- and then claims only the matches *beginning* in its own share,
    which is what stops the ones in the overlap being reported twice. A match
    beginning in the overlap belongs to the next block, which sees it whole.

    The one thing this cannot do is a single match longer than the overlap,
    which may be cut where two blocks meet. The default overlap is a megabase.

    ``end`` is exclusive here, as Python spans are; the caller converts.
    """
    if span <= 0 or not patterns:
        return [], 0, False, {item.id: 0 for item in patterns}

    step = max(1, scan_bp - overlap_bp)
    counts: Dict[str, int] = {item.id: 0 for item in patterns}
    found: List[Tuple[int, int, str]] = []
    total = 0
    truncated = False

    at = 0
    while at < span:
        stop = min(span, at + scan_bp)
        text = read(at, stop)
        # The last block has no successor to hand anything on to, so it claims
        # everything left. Every other block claims its own step and no more.
        claim = span - at if stop >= span else step
        for item in patterns:
            for match in item.expression.finditer(text):
                begin, finish = match.span()
                # An empty match is not a place in the sequence, and a pattern
                # that can produce one produces it at every position.
                if finish == begin or begin >= claim:
                    continue
                total += 1
                counts[item.id] += 1
                if len(found) < limit:
                    found.append((at + begin, at + finish, item.id))
                else:
                    truncated = True
        at += step

    # Gathered a pattern at a time inside each block, so the list arrives
    # grouped by pattern rather than in reading order.
    found.sort(key=lambda item: (item[0], item[1], item[2]))
    return found, total, truncated, counts


def matches_in_region(
    fetch: Callable[[int, int], str],
    low: int,
    high: int,
    patterns: List[Pattern],
    *,
    reverse: bool = False,
    complement: Optional[Callable[[str], str]] = None,
    limit: int = MAX_FIND_MATCHES,
    scan_bp: int = FIND_SCAN_BP,
    overlap_bp: int = FIND_OVERLAP_BP,
) -> FindResult:
    """Where the patterns match in ``low..high``, in genomic coordinates.

    ``fetch(start, stop)`` reads the forward strand, 0-based half-open, which is
    what the FASTA reader takes.

    The search is done on the sequence *as displayed*. A reader reading the
    reverse complement and looking for ATG means the ATG they can see, not its
    complement on the forward strand -- so on a reversed region the blocks are
    cut from the far end and complemented before they are scanned, and the
    offsets that come back are turned into coordinates the other way round.
    """
    span = high - low + 1
    if span <= 0:
        return FindResult([], 0, False, {item.id: 0 for item in patterns})

    def _read(at: int, stop: int) -> str:
        if reverse:
            raw = str(fetch(high - stop, high - at) or "").upper()
            return complement(raw) if complement else raw
        return str(fetch(low + at - 1, low + stop - 1) or "").upper()

    found, total, truncated, counts = scan_offsets(
        _read, span, patterns, limit=limit, scan_bp=scan_bp, overlap_bp=overlap_bp,
    )

    matches: List[List[object]] = []
    for begin, finish, pattern_id in found:
        if reverse:
            # Offset 0 is the region's last base, so a match runs back towards
            # the start and its two ends swap over.
            matches.append([high - finish + 1, high - begin, pattern_id])
        else:
            matches.append([low + begin, low + finish - 1, pattern_id])
    # Reversed, ascending offsets are descending coordinates.
    matches.sort(key=lambda item: (item[0], item[1]))
    return FindResult(matches, total, truncated, counts)
