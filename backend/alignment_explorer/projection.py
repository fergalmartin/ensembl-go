"""Alignment columns to genomic coordinates, and back, for one row of one block.

Two conventions meet here and neither may be allowed to leak into the other.

* Stored alignment rows carry **zero-based, half-open** forward-strand genomic
  intervals, whichever strand the row is on (``store.maf_blocks`` normalises
  them on import). Alignment columns are likewise zero-based and half-open.
* The GFF3 index the annotation provider reads is **one-based, inclusive**.

Everything in this module is zero-based half-open. Conversion happens once, at
the provider boundary in ``api.py``, and nowhere else.

The work is done from *runs of sequence*, not from a per-base map. A row's
chunks already carry ``ungapped_before``, so a single pass over the chunks that
a column window actually touches yields the segments of contiguous non-gap
bases in it, and both directions then cost a bisect. This is what keeps a block
of millions of columns bounded: only the requested window is ever read.
"""
from bisect import bisect_right

__all__ = ['row_segments', 'RowProjection', 'segment_pieces']


def row_segments(db, block, row_id, start, end):
    """Runs of non-gap bases in ``[start, end)`` of one row, in column order.

    Each segment is ``(column_start, column_end, ungapped_before)`` where
    ``ungapped_before`` counts the row's non-gap characters strictly before
    ``column_start`` — over the whole row, not over the window, so a segment
    keeps its meaning whatever window produced it.

    Only the chunks overlapping the window are read. A gap between two segments
    is exactly that: no base, and so no genomic coordinate.
    """
    if end <= start:
        return []
    segments = []
    rows = db.execute(
        'SELECT offset,bases,ungapped_before FROM chunks WHERE block=? AND id=? AND offset<? ORDER BY offset',
        (block, row_id, end))
    for chunk in rows:
        offset, bases, before = chunk['offset'], chunk['bases'], chunk['ungapped_before']
        if offset + len(bases) <= start:
            continue
        lo, hi = max(start, offset), min(end, offset + len(bases))
        # The count at the window's left edge, which is where this chunk's own
        # running total has to be carried forward from.
        cursor = before + len(bases[:lo - offset].replace('-', ''))
        run_start = None
        for index in range(lo - offset, hi - offset):
            if bases[index] == '-':
                if run_start is not None:
                    segments.append((run_start, offset + index, cursor - (offset + index - run_start)))
                    run_start = None
                continue
            if run_start is None:
                run_start = offset + index
            cursor += 1
        if run_start is not None:
            segments.append((run_start, hi, cursor - (hi - run_start)))
    # Chunk boundaries are a storage detail, not a break in the sequence.
    merged = []
    for segment in segments:
        if merged and merged[-1][1] == segment[0]:
            merged[-1] = (merged[-1][0], segment[1], merged[-1][2])
        else:
            merged.append(segment)
    return merged


def segment_pieces(segments, first, last):
    """The segments covering ungapped offsets ``[first, last)``, clipped.

    Returned as ``(column_start, column_end)`` pairs. Consecutive pairs with a
    gap between them are the alignment's own insertions in other rows; that is
    the whole reason a feature is returned as pieces rather than as one span.
    """
    pieces = []
    for column_start, column_end, before in segments:
        after = before + (column_end - column_start)
        lo, hi = max(first, before), min(last, after)
        if hi <= lo:
            continue
        pieces.append((column_start + (lo - before), column_start + (hi - before)))
    return pieces


class RowProjection:
    """One row of one block, over one column window.

    ``start``/``end`` are the row's forward-strand genomic interval and
    ``strand`` its orientation in the alignment. The row's own sequence runs
    5'→3' along the columns, so on the reverse strand the first column holds the
    *highest* genomic coordinate. Row strand is the only thing that decides
    this; a transcript's strand is a separate matter entirely and never enters
    here.
    """

    def __init__(self, row, segments, window):
        self.id = row['id']
        self.start, self.end = row['start'], row['end']
        self.strand = row['strand'] or '+'
        self.coordinates = bool(row['coordinates'])
        self.segments = segments
        self.window = window
        self._columns = [segment[0] for segment in segments]
        self._offsets = [segment[2] for segment in segments]

    # -- offsets -----------------------------------------------------------
    def offset_of(self, coordinate):
        """Ungapped offset of a zero-based genomic coordinate, or None."""
        if not self.coordinates or not (self.start <= coordinate < self.end):
            return None
        return coordinate - self.start if self.strand == '+' else self.end - 1 - coordinate

    def coordinate_of(self, offset):
        """Zero-based genomic coordinate of an ungapped offset, or None."""
        size = self.end - self.start
        if not self.coordinates or not (0 <= offset < size):
            return None
        return self.start + offset if self.strand == '+' else self.end - 1 - offset

    def offset_range(self, first, last):
        """Ungapped offsets for a genomic interval ``[first, last)``.

        Returns ``(requested, clamped)``. The two differ exactly where the
        feature runs off the end of the row, which is what lets a caller say a
        feature continues beyond the block rather than drawing it as complete.
        On the reverse strand the ends swap, because the row reads the other way
        along the same bases.
        """
        if not self.coordinates:
            return None
        size = self.end - self.start
        requested = (first - self.start, last - self.start) if self.strand == '+' else (self.end - last, self.end - first)
        clamped = (max(0, requested[0]), min(size, requested[1]))
        return requested, clamped

    # -- columns -----------------------------------------------------------
    def column_of(self, coordinate):
        """The alignment column a genomic coordinate falls in, or None when it
        is outside the row, outside the window, or — for the reverse of this
        question — a gap."""
        offset = self.offset_of(coordinate)
        if offset is None:
            return None
        index = bisect_right(self._offsets, offset) - 1
        if index < 0:
            return None
        column_start, column_end, before = self.segments[index]
        column = column_start + (offset - before)
        return column if column < column_end else None

    def at_column(self, column):
        """What is at a column: a genomic coordinate, or an explicit gap with the
        coordinates either side of it.

        A gap column has no genomic base, and inventing one — the nearest base,
        say — would make an insertion in another row read as sequence in this
        one. The flanking coordinates are given instead, so a caller can still
        say where in the genome the gap sits without being told it is a base.
        """
        index = bisect_right(self._columns, column) - 1
        if index >= 0:
            column_start, column_end, before = self.segments[index]
            if column < column_end:
                return {'gap': False, 'coordinate': self.coordinate_of(before + (column - column_start))}
        before_segment = self.segments[index] if index >= 0 else None
        after_segment = self.segments[index + 1] if index + 1 < len(self.segments) else None
        left = self.coordinate_of(before_segment[2] + (before_segment[1] - before_segment[0]) - 1) if before_segment else None
        right = self.coordinate_of(after_segment[2]) if after_segment else None
        return {'gap': True, 'coordinate': None, 'before': left, 'after': right}

    def window_coordinates(self):
        """The genomic interval this window's bases actually occupy, zero-based
        half-open — which is what the annotation index should be asked about.

        Asking for the whole row's interval would fetch genes nowhere near the
        columns on screen; asking for the window's columns is meaningless to an
        index that knows nothing about alignments. This is the translation
        between the two, and it is the only thing that bounds the gene query.
        """
        if not self.coordinates or not self.segments:
            return None
        first = self.segments[0][2]
        last = self.segments[-1][2] + (self.segments[-1][1] - self.segments[-1][0]) - 1
        a, b = self.coordinate_of(first), self.coordinate_of(last)
        if a is None or b is None:
            return None
        return (min(a, b), max(a, b) + 1)

    def project(self, first, last):
        """A genomic interval as alignment columns.

        Returns the covering envelope and the base-bearing pieces inside it.
        The envelope is what the feature occupies on the sheet; the pieces are
        where this row actually has bases. Drawing only the envelope would paint
        another row's insertion as exon body; drawing only the pieces would lose
        that the feature spans the gap between them.

        ``clipped_start``/``clipped_end`` say the feature carries on past the
        row or past the loaded window, at the low-column and high-column ends
        respectively, so it is never drawn as though it ended there. They are
        column-end statements, not genomic ones: on the reverse strand the end
        that is clipped is the one at the higher coordinate.
        """
        ranges = self.offset_range(first, last)
        if ranges is None:
            return None
        requested, clamped = ranges
        if clamped[1] <= clamped[0]:
            return None
        pieces = segment_pieces(self.segments, clamped[0], clamped[1])
        if not pieces:
            return None
        loaded = (self.segments[0][2], self.segments[-1][2] + (self.segments[-1][1] - self.segments[-1][0])) if self.segments else (0, 0)
        return {
            'start': pieces[0][0], 'end': pieces[-1][1],
            'pieces': [{'start': a, 'end': z} for a, z in pieces],
            'clipped_start': requested[0] < clamped[0] or clamped[0] < loaded[0],
            'clipped_end': requested[1] > clamped[1] or clamped[1] > loaded[1],
        }
