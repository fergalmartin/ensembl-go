"""Columns that carry nothing: the intersection of a cohort's gap runs.

A column is uninformative to a reader looking at a set of sequences when every
one of those sequences is a gap there. That is a property of the cohort and not
of the alignment: the same column is meaningful to a reader who has the sequence
whose insertion made it, and empty to one who has hidden that sequence. Nothing
here is stored against the block, because nothing here is true of the block.

Rows the block does not hold are not part of the answer. A sequence that is
absent has no gap there and no base there either — it says nothing about the
column, and counting its absence as a gap would let a block's non-members decide
what its members are allowed to see.
"""
import re
from array import array
from itertools import accumulate

GAP_RUN = re.compile(r'-+')


def runs_of_gap(text, offset=0):
    """Gap runs in one chunk of bases, as absolute half-open column ranges."""
    return [(offset + m.start(), offset + m.end()) for m in GAP_RUN.finditer(text)]


def intersect(left, right):
    """The ranges covered by both lists. Both are sorted and disjoint; so is the
    result, which is what lets this fold over a cohort one row at a time."""
    out, i, j = [], 0, 0
    while i < len(left) and j < len(right):
        a = max(left[i][0], right[j][0])
        z = min(left[i][1], right[j][1])
        if a < z:
            out.append((a, z))
        if left[i][1] < right[j][1]:
            i += 1
        else:
            j += 1
    return out


def merge_adjacent(ranges):
    """Sorted, with touching or overlapping ranges joined into one.

    A gap run that ends where the next chunk's begins is one run, not two, and
    leaving the seam in would let a `min_run` threshold reject a long gap for
    the accident of where the store cut it into chunks.
    """
    out = []
    for a, z in sorted(ranges):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], z)
        else:
            out.append([a, z])
    return [(a, z) for a, z in out]


def fill_uncovered(gaps, spans, start, end):
    """Gap runs plus the columns the row's own bases never reach.

    A row that stops short of the block's end has no base in the columns after
    it, which is the same statement a run of '-' makes. Treating the shortfall
    as sequence would keep a tail of columns the whole cohort is absent from.
    """
    covered = merge_adjacent([(max(start, a), min(end, z)) for a, z in spans if min(end, z) > max(start, a)])
    uncovered, cursor = [], start
    for a, z in covered:
        if a > cursor:
            uncovered.append((cursor, a))
        cursor = max(cursor, z)
    if cursor < end:
        uncovered.append((cursor, end))
    return merge_adjacent(list(gaps) + uncovered)


def gap_tally(width):
    """Somewhere to count how many rows are a gap in each column of a window.

    A difference array, not a count per column: a gap run of ten thousand
    columns is two entries here, one at each end, and the counts themselves are
    read off a single running sum at the end. Four bytes a column, allocated in
    one block, so what this costs is the width of the window and nothing about
    how gappy the alignment inside it is.

    The alternative - collecting the ends of every run and sorting them - is
    faster on a wide window that is barely gapped at all, and very much worse on
    the case that actually hurts: a heavily fragmented block of a few hundred
    thousand columns produced millions of entries to sort and over a hundred
    megabytes to hold them, where this holds two.
    """
    return array('i', bytes(4 * (width + 1)))


def tally_gaps(tally, ranges, start):
    """Add one row's gap runs to the tally, as offsets from the window start."""
    for a, z in ranges:
        tally[a - start] += 1
        tally[z - start] -= 1


def runs_at_least(tally, needed, start):
    """Half-open column runs where at least `needed` rows are a gap.

    The running sum is the count at each column, and a run is a stretch of
    columns where it stays at or above the threshold. Adjacent stretches are one
    run: the count never returns below the threshold between them, so there is
    nothing there for a reader to be told about.
    """
    if needed <= 0:
        return []
    out, opened = [], None
    for offset, count in enumerate(accumulate(tally)):
        if count >= needed:
            if opened is None:
                opened = offset
        elif opened is not None:
            out.append([start + opened, start + offset])
            opened = None
    return out


def rows_needed(present, percent):
    """How many of the rows actually in the block must be a gap.

    The denominator is the rows the block holds, not the cohort: a sequence the
    block does not carry has no gap there and no base there either, and letting
    its absence count towards a threshold would let a block's non-members decide
    what its members are allowed to see.

    Rounded up, and in whole rows, so a threshold means what it says of the
    sequences actually on the sheet: 50% of five rows is three, not two and a
    half, and 100% is every one of them - which is the intersection the all-gap
    answer already gives, so the two agree at the top of the range.
    """
    if present <= 0:
        return 0
    return max(1, -(-int(present) * int(percent) // 100))
