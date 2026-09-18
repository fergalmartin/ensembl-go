"""Working out which stretch of a chromosome a focus level is asking for.

Pure: plain values in, plain values out, no FastAPI and no import of ``main``.

Every coordinate here is 1-based inclusive on both ends, on the forward genomic
strand. That is the convention for the whole sequence view. The one place it is
not true is the pysam call itself, which is 0-based half-open; that conversion
happens in ``api.py`` at the moment of reading and nowhere else.
"""

from typing import Dict, List, Optional, Tuple

# What one read may ask for. The cap matches the browse endpoint's, deliberately:
# it exists to stop an accidental whole-chromosome fetch, and the sequence view
# never wants to approach it -- it reads in 12 kb pieces, because that is a
# fraction of a second's scrolling and it keeps the first paint after a jump to
# one short read.
MAX_TILE_BP = 100_000

# The most sequence that will be handed to the clipboard.
#
# Not a limit on how much can be read -- a whole chromosome is a few seconds of
# pysam -- but on what it is reasonable to put on the system clipboard. Human
# chromosome 1 is 249 Mb, which is 253 MB of FASTA: a string half of what V8 will
# hold at all, and an amount that most things a reader might paste into will
# struggle with. Twenty megabases covers every gene there is, with room over.
# Anything larger is a download, which streams and never builds a whole string.
MAX_CLIPBOARD_BP = 20_000_000

FASTA_LINE_WIDTH = 60

# How much sequence a streamed download reads at a time. A multiple of the line
# width, so a chunk boundary is always a line boundary and each chunk can be
# wrapped on its own.
FASTA_STREAM_BP = FASTA_LINE_WIDTH * 20_000


def clip_to_chromosome(start: int, end: int, chrom_length: Optional[int]) -> Optional[Tuple[int, int]]:
    """A window trimmed to the chromosome, or None when it falls entirely off it.

    A focus plus its flank routinely runs off the end of a contig -- a gene near
    a telomere with 100 bp of flank is the ordinary case, not a malformed
    request -- so this trims rather than refusing.
    """
    low = max(1, int(min(start, end)))
    high = int(max(start, end))
    if chrom_length is not None:
        high = min(high, int(chrom_length))
    if high < low:
        return None
    return low, high


def apply_flank(
    start: int,
    end: int,
    flank: int = 0,
    chrom_length: Optional[int] = None,
) -> Optional[Tuple[int, int]]:
    """A feature's window with the reader's flank either side, clipped to the contig."""
    pad = max(0, int(flank or 0))
    return clip_to_chromosome(int(min(start, end)) - pad, int(max(start, end)) + pad, chrom_length)


def apply_strand_flanks(
    start: int,
    end: int,
    five: int = 0,
    three: int = 0,
    strand: str = "+",
    chrom_length: Optional[int] = None,
) -> Optional[Tuple[int, int]]:
    """A feature's window with its 5' and 3' flanks, clipped to the contig.

    The one place a pair of flanks becomes a pair of coordinates. The reader
    asks for sequence upstream and downstream of the thing they are reading,
    which is what 5' and 3' mean; a window is low and high, which is what a
    coordinate is. On the minus strand the two swap, and nothing either side of
    this function has to know that they did.
    """
    upstream = max(0, int(five or 0))
    downstream = max(0, int(three or 0))
    low, high = (downstream, upstream) if strand == "-" else (upstream, downstream)
    return clip_to_chromosome(
        int(min(start, end)) - low, int(max(start, end)) + high, chrom_length,
    )


def soft_mask_runs(raw: str, start: int) -> List[Dict[str, int]]:
    """Where a sequence was lower-case, as runs of genomic coordinates.

    The assemblies this reads are soft-masked, and the browse endpoint upper-cases
    that information away. Keeping it as runs rather than as case means the
    sequence itself stays upper-case -- so every comparison, translation and
    FASTA export is unaffected -- while repeats remain available as one more
    overlay the reader can switch on.
    """
    runs: List[Dict[str, int]] = []
    run_start = None
    for offset, character in enumerate(raw):
        if character.islower():
            if run_start is None:
                run_start = offset
        elif run_start is not None:
            runs.append({"s": start + run_start, "e": start + offset - 1})
            run_start = None
    if run_start is not None:
        runs.append({"s": start + run_start, "e": start + len(raw) - 1})
    return runs


def fasta_header(chrom: str, start: int, end: int, strand: str = "+", genome: str = "") -> str:
    """A header a reader can paste back into the search box and land here again.

    Same shape as the location drawer writes (see frontend utils/locationFocus.js),
    so the two do not have to be told apart.
    """
    label = f"{chrom}:{int(start)}-{int(end)}"
    parts = [label, f"strand:{'-' if strand == '-' else '+'}"]
    name = str(genome or "").strip()
    if name:
        parts.append(f"genome:{name}")
    return ">" + " ".join(parts)


def wrap_sequence(sequence: str, width: int = FASTA_LINE_WIDTH) -> str:
    size = max(1, int(width))
    return "\n".join(sequence[i:i + size] for i in range(0, len(sequence), size))
